import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { attachmentPayload, backfillAttachments, filesFromInput } from "./attachments";
import type { Session } from "./auth";
import { publicBot } from "./admin-api";
import {
  createBot,
  getAttachmentForBot,
  getBot,
  getMessage,
  getMessageForBot,
  rotateBotKey,
  updateBot,
  saveAllowlist,
  saveSendPolicy,
  setBotWebhook,
  updateMessage,
} from "./db";
import { ensureDomains, listDomains } from "./domains";
import { junkOmitted, listMessages, messageDetail, searchMessages, summarize } from "./mailbox";
import { logError } from "./log";
import { approveDraft, createDraft, rejectDraft, replyToMessage, sendExistingDraft, submitOutbound } from "./outbound";
import { drainWebhooks } from "./webhook";
import { issueWebhookSetupCode } from "./webhook-setup";

const limitSchema = z.number().int().min(1).max(100).optional();
const attachmentInput = z.object({
  filename: z.string().min(1).max(200),
  content_type: z.string().max(200).optional(),
  content_base64: z.string().min(1),
  inline: z.boolean().optional(),
  content_id: z.string().max(200).optional(),
});

async function messageForBot(env: Env, botId: string, messageId: string, includeJunk: boolean) {
  const row = await getMessageForBot(env, botId, messageId);
  if (!row || junkOmitted(row.folder, includeJunk)) throw new Error("Message not found");
  return row;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function fail(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

async function run(action: () => Promise<unknown>) {
  try {
    return ok(await action());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    return fail(message);
  }
}

function registerBotTools(server: McpServer, env: Env, botId: string): void {
  server.registerTool(
    "list_messages",
    {
      description: 'List this bot\'s messages. Filters: unread, from, since (ISO date), folder, direction. The default list omits junk. Pass folder "junk" to list it.',
      inputSchema: z.object({
        unread: z.boolean().optional(),
        from: z.string().optional(),
        since: z.string().optional(),
        folder: z.string().optional(),
        direction: z.enum(["in", "out"]).optional(),
        limit: limitSchema,
      }),
    },
    async (args) =>
      run(async () => {
        const rows = await listMessages(env, botId, args);
        return { messages: rows.map(summarize) };
      }),
  );

  server.registerTool(
    "get_message",
    {
      description:
        "Get one message in this mailbox, including text and html bodies and attachment metadata. A junk message is not found unless include_junk is true. Without that flag the result matches a missing id.",
      inputSchema: z.object({ message_id: z.string(), include_junk: z.boolean().optional() }),
    },
    async ({ message_id, include_junk }) =>
      run(async () => {
        const row = await messageForBot(env, botId, message_id, include_junk === true);
        return messageDetail(env, row);
      }),
  );

  server.registerTool(
    "search_messages",
    {
      description:
        "Search this mailbox by subject, sender, snippet, or text body. Junk is omitted unless include_junk is true.",
      inputSchema: z.object({ query: z.string().min(1), limit: limitSchema, include_junk: z.boolean().optional() }),
    },
    async ({ query, limit, include_junk }) =>
      run(async () => {
        const rows = await searchMessages(env, botId, query, limit ?? 50, include_junk === true);
        return { messages: rows.map(summarize) };
      }),
  );

  server.registerTool(
    "get_thread",
    {
      description: "List every message in this mailbox that shares a thread id. Junk messages are left out unless include_junk is true.",
      inputSchema: z.object({ thread_id: z.string(), include_junk: z.boolean().optional() }),
    },
    async ({ thread_id, include_junk }) =>
      run(async () => {
        const result = await env.DB.prepare(
          `SELECT id FROM messages WHERE bot_id = ? AND thread_id = ? AND (? = 1 OR folder != 'junk') ORDER BY message_date ASC LIMIT 100`,
        )
          .bind(botId, thread_id, include_junk === true ? 1 : 0)
          .all<{ id: string }>();
        const messages = [];
        for (const item of result.results) {
          const row = await getMessageForBot(env, botId, item.id);
          if (row && !junkOmitted(row.folder, include_junk === true)) messages.push(await messageDetail(env, row));
        }
        return { thread_id, messages };
      }),
  );

  server.registerTool(
    "mark_read",
    {
      description: "Mark a message read or unread. Defaults to read. A junk message is not found unless include_junk is true.",
      inputSchema: z.object({ message_id: z.string(), read: z.boolean().optional(), include_junk: z.boolean().optional() }),
    },
    async ({ message_id, read, include_junk }) =>
      run(async () => {
        const row = await messageForBot(env, botId, message_id, include_junk === true);
        await updateMessage(env, row.id, { isRead: read !== false });
        return { id: row.id, is_read: read !== false };
      }),
  );

  server.registerTool(
    "list_attachments",
    {
      description:
        "List attachment metadata for one message in this mailbox. Does not return file bytes. A junk message is not found unless include_junk is true.",
      inputSchema: z.object({ message_id: z.string(), include_junk: z.boolean().optional() }),
    },
    async ({ message_id, include_junk }) =>
      run(async () => {
        const row = await messageForBot(env, botId, message_id, include_junk === true);
        const detail = await messageDetail(env, row);
        return { message_id: row.id, attachments: detail.attachments };
      }),
  );

  server.registerTool(
    "get_attachment",
    {
      description:
        "Read one attachment in this mailbox. text/* types return text. Other types return base64 and content_type. Above the size cap the call fails with an error and no bytes. An attachment on a junk message is not found unless include_junk is true.",
      inputSchema: z.object({ attachment_id: z.string(), include_junk: z.boolean().optional() }),
    },
    async ({ attachment_id, include_junk }) =>
      run(async () => {
        if (include_junk !== true) {
          const attachment = await getAttachmentForBot(env, botId, attachment_id);
          if (!attachment) throw new Error("Attachment not found");
          const message = await getMessageForBot(env, botId, attachment.message_id);
          if (message && junkOmitted(message.folder, false)) throw new Error("Attachment not found");
        }
        return attachmentPayload(env, botId, attachment_id);
      }),
  );

  server.registerTool(
    "create_draft",
    {
      description: "Store an outbound draft without sending it.",
      inputSchema: z.object({
        to: z.array(z.string()).min(1),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string(),
        text: z.string().optional(),
        html: z.string().optional(),
        in_reply_to: z.string().optional(),
        from: z.string().optional(),
      }),
    },
    async (args) =>
      run(async () => {
        const bot = await getBot(env, botId);
        if (!bot) throw new Error("Bot not found");
        return createDraft(env, bot, {
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          text: args.text,
          html: args.html,
          inReplyTo: args.in_reply_to,
          from: args.from,
        });
      }),
  );

  server.registerTool(
    "list_drafts",
    {
      description: "List drafts in this mailbox, including those waiting for approval.",
      inputSchema: z.object({}),
    },
    async () =>
      run(async () => {
        const rows = await listMessages(env, botId, { folder: "drafts", limit: 100 });
        return { drafts: rows.map(summarize) };
      }),
  );

  server.registerTool(
    "send_draft",
    {
      description: "Send a draft. In approval mode, recipients outside the BotMail domains and the allowlist are saved as pending_approval. In direct mode the message is sent immediately. A send to a BotMail recipient counts toward the auto-reply limit. The automated flag does not change that.",
      inputSchema: z.object({
        draft_id: z.string(),
        automated: z.boolean().optional(),
      }),
    },
    async ({ draft_id, automated }) =>
      run(async () => {
        const bot = await getBot(env, botId);
        if (!bot) throw new Error("Bot not found");
        return sendExistingDraft(env, bot, draft_id, "bot", automated === true);
      }),
  );

  server.registerTool(
    "send_email",
    {
      description: "Send email from this bot. In approval mode, mail outside the BotMail domains and the allowlist is saved as pending_approval. In direct mode every recipient is sent immediately. A send to a BotMail recipient counts toward the auto-reply limit. The automated flag does not change that. Only a dashboard approval or approve_draft is exempt. from may be this mailbox's address or an alias that delivers to it.",
      inputSchema: z.object({
        to: z.array(z.string()).min(1),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string(),
        text: z.string().optional(),
        html: z.string().optional(),
        in_reply_to: z.string().optional(),
        references: z.string().optional(),
        attachments: z.array(attachmentInput).max(20).optional(),
        automated: z.boolean().optional(),
        from: z.string().optional(),
      }),
    },
    async (args) =>
      run(async () => {
        const bot = await getBot(env, botId);
        if (!bot) throw new Error("Bot not found");
        return submitOutbound(env, bot, {
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          text: args.text,
          html: args.html,
          inReplyTo: args.in_reply_to,
          references: args.references,
          attachments: args.attachments ? filesFromInput(args.attachments) : undefined,
          automated: args.automated === true,
          from: args.from,
        }, "bot");
      }),
  );

  server.registerTool(
    "reply",
    {
      description:
        "Reply to a message in this mailbox. Threading headers are set. In approval mode, external recipients are held for approval. A reply to a BotMail recipient counts toward the auto-reply limit. The automated flag does not change that. A junk message is not found unless include_junk is true. from may be this mailbox's address or an alias that delivers to it. Mail that arrived on such an alias is replied from that alias unless from is set.",
      inputSchema: z.object({
        message_id: z.string(),
        text: z.string().optional(),
        html: z.string().optional(),
        attachments: z.array(attachmentInput).max(20).optional(),
        automated: z.boolean().optional(),
        include_junk: z.boolean().optional(),
        from: z.string().optional(),
      }),
    },
    async ({ message_id, text, html, attachments, automated, include_junk, from }) =>
      run(async () => {
        const bot = await getBot(env, botId);
        if (!bot) throw new Error("Bot not found");
        return replyToMessage(env, bot, message_id, {
          text,
          html,
          attachments: attachments ? filesFromInput(attachments) : undefined,
          automated: automated === true,
          includeJunk: include_junk === true,
          from,
        });
      }),
  );

  server.registerTool(
    "set_webhook",
    {
      description:
        "Save this mailbox's wake webhook from a script. url is the routine Webhook URL (https). key is the Routine Webhook key from the routine panel. A leading Bearer and surrounding whitespace are removed. An empty key is rejected and nothing is saved. The placeholder [REDACTED] is rejected. Chat setup must call webhook_setup_code and POST the key from the shell instead. Never repeat the key in chat.",
      inputSchema: z.object({ url: z.string(), key: z.string().optional() }),
    },
    async ({ url, key }) =>
      run(async () => {
        await setBotWebhook(env, botId, url, key);
        return { bot: botId, webhook_url: url.trim() };
      }),
  );

  server.registerTool(
    "webhook_setup_code",
    {
      description:
        "Issue a one-time code so this mailbox can save its Routine Webhook key from the shell. The code expires in 10 minutes and works once. Do not pass the key to this tool. POST JSON {code, url, key} to https://<publicHost>/webhook-setup from a fresh login shell (bash -lc), reading the key from the environment variable set by the masked form.",
      inputSchema: z.object({}),
    },
    async () =>
      run(async () => {
        const issued = await issueWebhookSetupCode(env, botId);
        return { ...issued, bot: botId };
      }),
  );
}

function registerAdminTools(server: McpServer, env: Env): void {
  server.registerTool(
    "create_bot",
    {
      description:
        "Create a bot mailbox local_part@domain and return its API key once. domain defaults to the default mail domain (see list_domains). id defaults to local_part, or local_part.<domain tag> when that id is taken. notes records the owner and purpose.",
      inputSchema: z.object({
        id: z.string().optional(),
        local_part: z.string().optional(),
        domain: z.string().optional(),
        display_name: z.string().optional(),
        notes: z.string().max(2000).optional(),
      }),
    },
    async ({ id, local_part, domain, display_name, notes }) =>
      run(async () => {
        if (!id?.trim() && !local_part?.trim()) throw new Error("local_part or id is required");
        const created = await createBot(env, { id, local: local_part, domain, displayName: display_name, notes });
        return { ...publicBot(env, created.bot), api_key: created.apiKey, apiKey: created.apiKey };
      }),
  );

  server.registerTool(
    "update_bot",
    {
      description: "Update a bot's display name, notes (owner and purpose), or enabled flag. The address does not change.",
      inputSchema: z.object({
        bot: z.string(),
        display_name: z.string().optional(),
        notes: z.string().max(2000).optional(),
        enabled: z.boolean().optional(),
      }),
    },
    async ({ bot, display_name, notes, enabled }) =>
      run(async () => publicBot(env, await updateBot(env, bot, { displayName: display_name, notes, enabled }))),
  );

  server.registerTool(
    "list_domains",
    {
      description: "List mail domains with their routing, sending, and DNS status and bot counts.",
      inputSchema: z.object({}),
    },
    async () =>
      run(async () => ({
        domains: (await listDomains(env)).map(({ manual_steps: _steps, dns_commands: _commands, ...rest }) => rest),
      })),
  );

  server.registerTool(
    "rotate_key",
    {
      description: "Rotate a bot API key. The previous key stops working. The new key is returned once.",
      inputSchema: z.object({ bot: z.string() }),
    },
    async ({ bot }) => run(async () => ({ bot, api_key: await rotateBotKey(env, bot) })),
  );

  server.registerTool(
    "set_webhook",
    {
      description:
        "Save a bot wake webhook. url is the routine Webhook URL (https). key is the Routine Webhook key from the routine panel. A leading Bearer and surrounding whitespace are removed. An empty key is rejected and nothing is saved. The placeholder [REDACTED] is rejected.",
      inputSchema: z.object({ bot: z.string(), url: z.string(), key: z.string().optional() }),
    },
    async ({ bot, url, key }) =>
      run(async () => {
        await setBotWebhook(env, bot, url, key);
        return { bot, webhook_url: url.trim() };
      }),
  );

  server.registerTool(
    "list_pending_drafts",
    {
      description: "List drafts waiting for external-send approval.",
      inputSchema: z.object({}),
    },
    async () =>
      run(async () => {
        const result = await env.DB.prepare(
          `SELECT id, bot_id FROM messages WHERE status = 'pending_approval' ORDER BY created_at ASC LIMIT 100`,
        ).all<{ id: string; bot_id: string }>();
        const drafts = [];
        for (const item of result.results) {
          const row = await getMessage(env, item.id);
          if (row) drafts.push(summarize(row));
        }
        return { drafts };
      }),
  );

  server.registerTool(
    "approve_draft",
    {
      description: "Approve a pending external draft and send it.",
      inputSchema: z.object({ draft_id: z.string() }),
    },
    async ({ draft_id }) => run(() => approveDraft(env, draft_id)),
  );

  server.registerTool(
    "reject_draft",
    {
      description: "Reject a pending external draft. It is not sent.",
      inputSchema: z.object({ draft_id: z.string(), reason: z.string().optional() }),
    },
    async ({ draft_id, reason }) => run(() => rejectDraft(env, draft_id, reason)),
  );

  server.registerTool(
    "set_allowlist",
    {
      description: "Replace the D1 send allowlist. Entries are full emails or domains. Enabled BotMail domains are always allowed.",
      inputSchema: z.object({ entries: z.array(z.string()) }),
    },
    async ({ entries }) => run(async () => ({ allowlist: await saveAllowlist(env, entries) })),
  );

  server.registerTool(
    "set_send_policy",
    {
      description: "Store send policy direct or approval. A SEND_POLICY var from the group config overrides this.",
      inputSchema: z.object({ policy: z.enum(["direct", "approval"]) }),
    },
    async ({ policy }) => run(() => saveSendPolicy(env, policy)),
  );

  server.registerTool(
    "backfill_attachments",
    {
      description:
        "Parse stored .eml objects that have not been scanned and write their attachments to R2 and D1. One-off. limit defaults to 25 and maxes at 100.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    },
    async ({ limit }) => run(() => backfillAttachments(env, limit ?? 25)),
  );

  server.registerTool(
    "drain_webhooks",
    {
      description: "Retry failed webhook deliveries.",
      inputSchema: z.object({}),
    },
    async () => run(() => drainWebhooks(env, 20)),
  );
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext, session: Session): Promise<Response> {
  await ensureDomains(env);
  const hostname = new URL(request.url).hostname;
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "bot-mail", version: "0.1.0" });
      if (session.kind === "admin") registerAdminTools(server, env);
      else registerBotTools(server, env, session.bot.id);
      return server;
    },
    {
      route: "/mcp",
      responseMode: "json",
      allowedHostnames: [hostname],
    },
  );
  return handler(request, env, ctx).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "MCP request failed";
    logError("mcp_failed", { error: message });
    return Response.json({ error: "MCP request failed" }, { status: 500 });
  });
}
