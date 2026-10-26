import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rotateBotKey } from "../src/db";
import { deliver, mcpCall, rawMime } from "./helpers";

describe("MCP auth scoping", () => {
  it("does not let bot A read bot B", async () => {
    const forgeKey = await rotateBotKey(env, "forge");
    const vespaKey = await rotateBotKey(env, "vespa");
    const secretSubject = "Vespa eyes only 9f3c";
    await deliver(
      rawMime({
        from: "ada@example.com",
        to: "vespa@bots.example.test",
        subject: secretSubject,
        text: "private vespa note",
        messageId: "<vespa-private@bots.example.test>",
      }),
      "ada@example.com",
      "vespa@bots.example.test",
    );
    const vespaRow = await env.DB.prepare(`SELECT id FROM messages WHERE message_id_header = ?`)
      .bind("<vespa-private@bots.example.test>")
      .first<{ id: string }>();

    const forgeList = (await mcpCall(forgeKey, "list_messages", {})) as { messages: Array<{ subject: string }> };
    expect(forgeList.messages.some((message) => message.subject === secretSubject)).toBe(false);

    const forgeSearch = (await mcpCall(forgeKey, "search_messages", { query: secretSubject })) as {
      messages: unknown[];
    };
    expect(forgeSearch.messages).toEqual([]);

    await expect(mcpCall(forgeKey, "get_message", { message_id: vespaRow?.id ?? "" })).rejects.toThrow(/not found/i);

    const vespaList = (await mcpCall(vespaKey, "list_messages", { unread: true })) as {
      messages: Array<{ id: string; subject: string }>;
    };
    expect(vespaList.messages.some((message) => message.id === vespaRow?.id)).toBe(true);

    const unread = await mcpCall(vespaKey, "mark_read", { message_id: vespaRow?.id ?? "" });
    expect(unread).toMatchObject({ is_read: true });
    const after = (await mcpCall(vespaKey, "list_messages", { unread: true })) as { messages: Array<{ id: string }> };
    expect(after.messages.some((message) => message.id === vespaRow?.id)).toBe(false);
  });

  it("rejects a missing key and hides admin tools from a bot", async () => {
    const ctxResponse = await (await import("../src/index")).default.fetch(
      new Request(`https://${env.PUBLIC_HOST}/mcp`, {
        method: "POST",
        headers: { host: env.PUBLIC_HOST, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_messages", arguments: {} } }),
      }),
      env,
    );
    expect(ctxResponse.status).toBe(401);

    const forgeKey = await rotateBotKey(env, "post");
    await expect(mcpCall(forgeKey, "approve_draft", { draft_id: "nope" })).rejects.toThrow();
    await expect(mcpCall("test-admin-key", "list_messages", {})).rejects.toThrow();
  });
});
