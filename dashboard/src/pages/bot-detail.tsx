import { useEffect, useState } from "preact/hooks";
import { api, type Bot, type Connector } from "../api";
import { useApp } from "../app";
import { fullTime, relativeTime } from "../format";
import { AlertIcon, BoltIcon, BotIcon, ChevronLeft, ChevronRight, CopyIcon, EyeOffIcon, InboxIcon, KeyIcon, NotesIcon, PlugIcon } from "../icons";
import { linkHandler } from "../router";
import { buildSetupPrompt } from "../../../src/setup-prompt";
import { toast, toastError } from "../toast";
import { Avatar, Badge, Button, CodeBlock, CopyButton, CopyField, EmptyState, Field, Input, LinkButton, Modal, Panel, Select, Skeleton, Switch, Textarea, copyText, useResource } from "../ui";
import { StatusBadge } from "./bots";

type WakeResult = { status: string; code?: number | null; error?: string | null; at: string };

export function BotDetailPage({ id }: { id: string }) {
  const { reloadBots, session } = useApp();
  const resource = useResource(async () => (await api<{ bot: Bot }>(`/bots/${encodeURIComponent(id)}`)).bot, [id]);
  const bot = resource.data;
  const refresh = async () => {
    await resource.reload();
    await reloadBots();
  };

  if (resource.error) {
    return (
      <div class="page page-center">
        <EmptyState
          icon={<BotIcon size={18} />}
          title="Bot not found"
          body={`No bot with id “${id}” exists on this deployment.`}
          action={<LinkButton href="/bots">All bots</LinkButton>}
        />
      </div>
    );
  }

  return (
    <div class="page">
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="/bots" onClick={linkHandler("/bots")}>
          <ChevronLeft size={13} /> Bots
        </a>
        <ChevronRight size={12} class="crumb-sep" />
        <span class="mono">{id}</span>
      </nav>
      <header class="bot-hero">
        {bot ? <Avatar seed={bot.id} label={bot.display_name} size={48} square /> : <Skeleton width="48px" height={48} radius={12} />}
        <div class="bot-hero-text">
          <h1 class="page-title page-title-lg">{bot ? bot.display_name || bot.id : <Skeleton width="160px" height={20} />}</h1>
          <div class="bot-hero-meta">
            {bot ? (
              <>
                <span class="mono addr">{bot.address}</span>
                <CopyButton value={bot.address} label="Copy address" />
                {bot.archived ? <Badge tone="amber">Archived</Badge> : <StatusBadge enabled={bot.enabled} />}
                {bot.id !== bot.address_local && <span class="bot-hero-id mono">id {bot.id}</span>}
                <span class="bot-hero-id">{bot.owner_email ? <>Owner <span class="mono">{bot.owner_email}</span></> : "No owner"}</span>
              </>
            ) : (
              <Skeleton width="220px" height={12} />
            )}
          </div>
          {bot?.notes && (
            <p class="bot-hero-notes" title={bot.notes}>
              <NotesIcon size={13} />
              <span>{bot.notes}</span>
            </p>
          )}
        </div>
        <div class="page-actions">
          <LinkButton href={`/mail?bot=${encodeURIComponent(id)}`} icon={<InboxIcon size={14} />}>
            Open inbox
          </LinkButton>
        </div>
      </header>
      {bot && (
        <div class="stat-strip">
          <Stat label="Messages" value={String(bot.message_count)} />
          <Stat label="Unread" value={String(bot.unread_count)} tone={bot.unread_count ? "accent" : undefined} />
          <Stat label="Last mail" value={bot.last_mail_at ? relativeTime(bot.last_mail_at) : "None"} title={fullTime(bot.last_mail_at)} />
          <Stat label="Webhook" value={`URL set: ${bot.webhook_url ? "Yes" : "No"} · Key set: ${bot.webhook_configured ? "Yes" : "No"}`} />
        </div>
      )}
      <div class="detail-grid">
        <div class="detail-main">
          {bot && !bot.archived && <SetupPrompt bot={bot} mcpUrl={session.mcp_url || bot.mcp_url} />}
          {bot ? (
            <ConnectPanel bot={bot} mcpUrl={session.mcp_url || bot.mcp_url} onChanged={refresh} />
          ) : (
            <Panel title="Connect">
              <Skeleton height={160} radius={10} />
            </Panel>
          )}
        </div>
        <aside class="detail-side">{bot && <BotSettings bot={bot} onChanged={refresh} />}</aside>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, title }: { label: string; value: preact.ComponentChildren; tone?: "accent"; title?: string }) {
  return (
    <div class="stat" title={title}>
      <div class="stat-label">{label}</div>
      <div class={`stat-value ${tone === "accent" ? "is-accent" : ""}`}>{value}</div>
    </div>
  );
}

function SetupPrompt({ bot, mcpUrl }: { bot: Bot; mcpUrl: string }) {
  const text = buildSetupPrompt({
    id: bot.id,
    address: bot.address,
    domain: bot.domain,
    mcpUrl,
  });
  return (
    <Panel eyebrow="One paste into this bot's chat" title="Setup prompt" class="setup-prompt">
      <p class="setup-lead">
        Copy a single message that tells {bot.display_name || bot.id} to finish setup in this chat: use its BotMail account, click Connect and sign in, create the inbox routine, and save the webhook from its shell.
      </p>
      <Button class="setup-copy" variant="primary" icon={<CopyIcon size={15} />} onClick={() => void copyText(text, "Setup prompt copied")}>
        Copy setup prompt
      </Button>
      <pre class="setup-preview mono">{text}</pre>
    </Panel>
  );
}

function ConnectPanel({ bot, mcpUrl, onChanged }: { bot: Bot; mcpUrl: string; onChanged: () => Promise<void> }) {
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [revealed, setRevealed] = useState("");
  const [rotating, setRotating] = useState(false);
  const [hookUrl, setHookUrl] = useState(bot.webhook_url ?? "");
  const [hookKey, setHookKey] = useState("");
  const [savingHook, setSavingHook] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wake, setWake] = useState<WakeResult | null>(null);
  useEffect(() => setHookUrl(bot.webhook_url ?? ""), [bot.webhook_url]);
  useEffect(() => {
    setRevealed("");
  }, [bot.id]);

  const rotate = async () => {
    setRotating(true);
    try {
      const body = await api<{ authorization: string }>(`/bots/${encodeURIComponent(bot.id)}/key`, { method: "POST", body: {} });
      setRevealed(body.authorization);
      setConfirmRotate(false);
      toast("New key issued", { detail: "The previous key stopped working." });
    } catch (error) {
      toastError(error, "Could not rotate key");
    } finally {
      setRotating(false);
    }
  };

  const saveHook = async () => {
    setSavingHook(true);
    try {
      await api(`/bots/${encodeURIComponent(bot.id)}/webhook`, { method: "PUT", body: { url: hookUrl.trim(), key: hookKey || undefined } });
      setHookKey("");
      toast("Webhook saved");
      await onChanged();
    } catch (error) {
      toastError(error, "Could not save webhook");
    } finally {
      setSavingHook(false);
    }
  };

  const testWake = async () => {
    setWaking(true);
    try {
      const body = await api<{ status: string; last_status_code?: number | null; code?: number | null; error?: string | null; last_error?: string | null }>(
        `/bots/${encodeURIComponent(bot.id)}/test-wake`,
        { method: "POST", body: {} },
      );
      const result = { status: body.status, code: body.code ?? body.last_status_code ?? null, error: body.error ?? body.last_error ?? null, at: new Date().toISOString() };
      setWake(result);
      if (result.status === "success") toast("Test wake delivered", { detail: result.code ? `HTTP ${result.code}` : undefined });
      else toast("Test wake failed", { kind: "error", detail: result.error || undefined });
      await onChanged();
    } catch (error) {
      toastError(error, "Test wake failed");
    } finally {
      setWaking(false);
    }
  };

  const connectorUrl = mcpUrl || "https://<publicHost>/mcp";

  return (
    <Panel eyebrow="Remote MCP · Streamable HTTP" title="Connect" class="connect" actions={<Badge tone="accent">Primary path</Badge>}>
      {bot.archived && (
        <div class="inline-alert">
          <AlertIcon size={14} /> This mailbox is archived. Restore it before connecting again. Existing connectors can still be revoked below.
        </div>
      )}
      <ol class="steps">
        <li class="step">
          <div class="step-index">1</div>
          <div class="step-body">
            <div class="step-title">Remote connector, no headers</div>
            <div class="step-desc">
              Use the shared <span class="mono">BotMail</span> connector with this URL and no headers. Add an account named <span class="mono">{bot.id}</span>, then click Connect and sign in, and pick or create <span class="mono">{bot.id}</span>. Nothing is installed on the bot's machine.
            </div>
            <CopyField value={mcpUrl} label="Copy MCP URL" placeholder="Set publicHost in the group config to get an MCP URL" />
            <CodeBlock title="Custom connector" code={`Name:      BotMail\nURL:       ${connectorUrl}\nTransport: Streamable HTTP\nHeaders:   none\nAccount:   ${bot.id}`} label="Copy connector settings" />
          </div>
        </li>
        <li class="step">
          <div class="step-index">2</div>
          <div class="step-body">
            <div class="step-title">Connected clients</div>
            <div class="step-desc">One mailbox has one connection. Revoke it here before that mailbox can be chosen on the Connect page again. Refresh tokens stay valid until then.</div>
            <Connectors botId={bot.id} />
          </div>
        </li>
        <li class="step">
          <div class="step-index">3</div>
          <div class="step-body">
            <div class="step-title">Routine webhook</div>
            <div class="step-desc">BotMail POSTs here when mail arrives. The Routine Webhook key is the Webhook key field on the Grok routine panel.</div>
            <div class="hook-status-line" aria-label="Webhook status">
              <span>URL set: <strong>{bot.webhook_url ? "Yes" : "No"}</strong></span>
              <span>Key set: <strong>{bot.webhook_configured ? "Yes" : "No"}</strong></span>
            </div>
            <div class="hook-grid">
              <Field label="Webhook URL" htmlFor="hook-url">
                <Input id="hook-url" mono value={hookUrl} placeholder="https://hooks.example.com/wake" onInput={(event) => setHookUrl((event.currentTarget as HTMLInputElement).value)} />
              </Field>
              <Field label="Routine Webhook key" htmlFor="hook-key" hint={bot.webhook_configured ? "Stored encrypted. Leave blank to keep it. A leading Bearer is removed." : "From the routine panel's Webhook key field."}>
                <Input id="hook-key" type="password" mono value={hookKey} placeholder={bot.webhook_configured ? "•••••••••••• stored" : "Paste the Routine Webhook key"} autoComplete="new-password" onInput={(event) => setHookKey((event.currentTarget as HTMLInputElement).value)} />
              </Field>
            </div>
            <div class="hook-actions">
              <Button variant="secondary" loading={savingHook} onClick={() => void saveHook()} disabled={bot.archived || (hookUrl === (bot.webhook_url ?? "") && !hookKey)}>
                Save webhook
              </Button>
              <Button variant="accent" icon={<BoltIcon size={14} />} loading={waking} disabled={bot.archived || !bot.webhook_url} onClick={() => void testWake()}>
                Send test wake
              </Button>
            </div>
            <p class={wake ? (wake.status === "success" ? "hook-wake-result text-green" : "hook-wake-result text-red") : "hook-wake-result"}>
              Test wake:{" "}
              {wake
                ? `${wake.status === "success" ? "Delivered" : "Failed"}${wake.code ? ` · HTTP ${wake.code}` : ""}${wake.error ? ` · ${wake.error}` : ""} · ${relativeTime(wake.at)}`
                : bot.webhook_last_at
                  ? `${bot.webhook_last_error ? `Failed · ${bot.webhook_last_error}` : "Delivered"} · ${relativeTime(bot.webhook_last_at)}`
                  : "Not run yet"}
            </p>
          </div>
        </li>
        <li class="step">
          <div class="step-index">4</div>
          <div class="step-body">
            <div class="step-title">Scripts and existing bridges</div>
            <div class="step-desc">Static bearer keys still work for scripts and for a bridge you have not moved yet. A remote connector does not use this key.</div>
            {revealed ? (
              <div class="reveal">
                <div class="reveal-head">
                  <KeyIcon size={14} /> Script key, shown once
                  <button class="reveal-hide" onClick={() => setRevealed("")}>
                    <EyeOffIcon size={13} /> Hide
                  </button>
                </div>
                <div class="reveal-value mono">{revealed}</div>
                <div class="reveal-actions">
                  <CopyButton value={revealed} label="Copy bearer value" text="Copy value" size="md" />
                  <span class="reveal-note">Copy it now. Leaving this page discards it.</span>
                </div>
              </div>
            ) : (
              <Button variant="secondary" icon={<KeyIcon size={14} />} disabled={bot.archived} onClick={() => setConfirmRotate(true)}>
                Reveal new key
              </Button>
            )}
            <details class="fallback">
              <summary>
                <PlugIcon size={13} /> Local bridge fallback
              </summary>
              <p>Only for a client that cannot click Connect. The bridge reads the key from <span class="mono">.bot-mail.secrets</span> and dies if that box resets.</p>
              <CodeBlock title="Terminal" code={`bin/botmail-mcp ${bot.id} ${connectorUrl}`} />
            </details>
          </div>
        </li>
      </ol>
      <Modal
        open={confirmRotate}
        onClose={() => setConfirmRotate(false)}
        title="Issue a new key?"
        description={
          <>
            The current key for <span class="mono">{bot.id}</span> stops working immediately. Any connector using it must be updated with the new header.
          </>
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRotate(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={rotating} onClick={() => void rotate()}>
              Rotate and reveal
            </Button>
          </>
        }
      />
    </Panel>
  );
}

function Connectors({ botId }: { botId: string }) {
  const resource = useResource(async () => (await api<{ connectors: Connector[] }>(`/bots/${encodeURIComponent(botId)}/connectors`)).connectors, [botId]);
  const [busy, setBusy] = useState("");
  const revoke = async (grantId: string) => {
    setBusy(grantId);
    try {
      await api(`/bots/${encodeURIComponent(botId)}/connectors/${encodeURIComponent(grantId)}/revoke`, { method: "POST", body: {} });
      toast("Connector revoked");
      await resource.reload();
    } catch (error) {
      toastError(error, "Could not revoke connector");
    } finally {
      setBusy("");
    }
  };
  if (resource.error) return <p class="connector-meta">Could not load connected clients.</p>;
  if (!resource.data) return <Skeleton height={48} radius={10} />;
  if (resource.data.length === 0) return <p class="connector-meta">No connection yet. Add an account on the BotMail connector and click Connect.</p>;
  return (
    <div class="connector-list">
      {resource.data.map((row) => (
        <div class="connector-row" key={row.grant_id}>
          <div class="grow">
            <div>{row.client_name}</div>
            <div class="connector-meta" title={fullTime(row.last_used_at)}>
              Created {relativeTime(row.created_at)} · Last used {relativeTime(row.last_used_at)}
            </div>
          </div>
          <Button variant="danger" size="sm" loading={busy === row.grant_id} onClick={() => void revoke(row.grant_id)}>
            Revoke
          </Button>
        </div>
      ))}
    </div>
  );
}

function BotSettings({ bot, onChanged }: { bot: Bot; onChanged: () => Promise<void> }) {
  const { session, bots, multiDomain } = useApp();
  const [name, setName] = useState(bot.display_name);
  const [notes, setNotes] = useState(bot.notes);
  const [owner, setOwner] = useState(bot.owner_email ?? "");
  const [localPart, setLocalPart] = useState(bot.address_local);
  const [domain, setDomain] = useState(bot.domain);
  const [forwardTo, setForwardTo] = useState(bot.forward_to ?? "");
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  useEffect(() => setName(bot.display_name), [bot.display_name]);
  useEffect(() => setNotes(bot.notes), [bot.notes]);
  useEffect(() => setOwner(bot.owner_email ?? ""), [bot.owner_email]);
  useEffect(() => {
    setLocalPart(bot.address_local);
    setDomain(bot.domain);
    setForwardTo(bot.forward_to ?? "");
  }, [bot.address_local, bot.domain, bot.forward_to]);
  const notesDirty = notes.trim() !== bot.notes;
  const ownerDirty = owner.trim().toLowerCase() !== (bot.owner_email ?? "");
  const ownerInvalid = owner.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.trim());
  const addressDirty = localPart.trim().toLowerCase() !== bot.address_local || domain !== bot.domain;
  const forwardDirty = (forwardTo || "") !== (bot.forward_to ?? "");
  const forwardChoices = bots.filter((item) => item.id !== bot.id && !item.id.startsWith("_") && !item.archived);
  const domains = (session.domains ?? []).filter((item) => item.enabled);

  const patch = async (body: Record<string, unknown>, message: string) => {
    setSaving(true);
    try {
      await api(`/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body });
      toast(message);
      await onChanged();
    } catch (error) {
      toastError(error, "Could not update bot");
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    setArchiving(true);
    try {
      await api(`/bots/${encodeURIComponent(bot.id)}`, { method: "DELETE" });
      setArchiveOpen(false);
      setConfirm("");
      toast(`Archived ${bot.display_name || bot.id}`, { detail: "Mail and notes stay. Restore it here, then rotate the key." });
      await onChanged();
    } catch (error) {
      toastError(error, "Could not archive bot");
    } finally {
      setArchiving(false);
    }
  };

  const restore = async () => {
    setArchiving(true);
    try {
      await api(`/bots/${encodeURIComponent(bot.id)}/restore`, { method: "POST", body: {} });
      toast(`Restored ${bot.display_name || bot.id}`, { detail: "Rotate the key. The previous one no longer works." });
      await onChanged();
    } catch (error) {
      toastError(error, "Could not restore bot");
    } finally {
      setArchiving(false);
    }
  };

  return (
    <>
      <Panel title="Owner" eyebrow="Zero Trust user">
        <div class="form-stack">
          <Field
            label="Email"
            htmlFor="bot-owner"
            hint={ownerInvalid ? <span class="text-red">Enter an email address, or leave it blank to clear.</span> : "Set when this mailbox is created from Connect or this dashboard. Older mailboxes stay blank until you save one. Connecting does not change it."}
          >
            <Input id="bot-owner" type="email" value={owner} placeholder="ada@example.com" autoComplete="off" onInput={(event) => setOwner((event.currentTarget as HTMLInputElement).value)} />
          </Field>
          <div class="notes-foot">
            <span class="field-hint">{bot.owner_email ? "Saved on this mailbox." : "No owner yet."}</span>
            <Button size="sm" variant="secondary" loading={saving} disabled={!ownerDirty || ownerInvalid} onClick={() => void patch({ owner_email: owner.trim() }, owner.trim() ? "Owner saved" : "Owner cleared")}>
              Save owner
            </Button>
          </div>
        </div>
      </Panel>
      <Panel title="Notes" eyebrow="Optional">
        <div class="form-stack">
          <Textarea id="bot-notes" label="Notes" value={notes} onInput={setNotes} rows={4} maxLength={2000} placeholder="What this mailbox is for." />
          <div class="notes-foot">
            <span class="field-hint">Optional. Shown on hover next to this mailbox in every list.</span>
            <Button size="sm" variant="secondary" loading={saving} disabled={bot.archived || !notesDirty} onClick={() => void patch({ notes: notes.trim() }, notes.trim() ? "Notes saved" : "Notes cleared")}>
              Save notes
            </Button>
          </div>
        </div>
      </Panel>
      <Panel title="Mailbox" eyebrow="Settings">
        <div class="form-stack">
          <Field label="Display name" htmlFor="bot-name">
            <Input id="bot-name" value={name} onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)} />
          </Field>
          <Button variant="secondary" loading={saving} disabled={bot.archived || name.trim() === bot.display_name || !name.trim()} onClick={() => void patch({ display_name: name.trim() }, "Name saved")}>
            Save name
          </Button>
          <Field label="Address" htmlFor="bot-local">
            <Input
              id="bot-local"
              mono
              value={localPart}
              suffix={multiDomain ? undefined : `@${bot.domain}`}
              disabled={bot.archived}
              onInput={(event) => setLocalPart((event.currentTarget as HTMLInputElement).value)}
            />
          </Field>
          {multiDomain && (
            <Select label="Domain" value={domain} onChange={setDomain} options={domains.map((item) => ({ value: item.domain, label: item.domain }))} />
          )}
          <p class="field-hint">
            Saving a new address keeps id <span class="mono">{bot.id}</span>, the mail, the webhook, and the connector. <span class="mono">{bot.address}</span> becomes an alias that still delivers here.
          </p>
          {session.routing_mode === "literal" && (
            <p class="field-hint">This install uses literal routing. Add a literal rule for the new address and leave the old rule in place so the alias still receives mail.</p>
          )}
          <Button
            variant="secondary"
            loading={saving}
            disabled={bot.archived || !addressDirty || !/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(localPart.trim())}
            onClick={() => void patch({ address_local: localPart.trim().toLowerCase(), domain }, "Address saved. The previous address is now an alias.")}
          >
            Save address
          </Button>
          <Field label="When disabled, also deliver to" htmlFor="bot-forward">
            <Select
              label="Forward target"
              value={forwardTo}
              onChange={setForwardTo}
              options={[{ value: "", label: "Nowhere" }, ...forwardChoices.map((item) => ({ value: item.id, label: item.display_name || item.id }))]}
            />
          </Field>
          <p class="field-hint">
            Applies only while this mailbox is disabled. The disabled mailbox keeps its own copy. Junk and quarantine stay here. If the target is disabled, the mail is not forwarded on.
          </p>
          <Button variant="secondary" loading={saving} disabled={bot.archived || !forwardDirty} onClick={() => void patch({ forward_to: forwardTo || null }, forwardTo ? "Forward on disable saved" : "Forward on disable cleared")}>
            Save forward
          </Button>
          <div class="setting-row">
            <div>
              <div class="setting-title">Receive mail</div>
              <div class="setting-desc">
                {bot.archived
                  ? "Archived. New mail for this address is held in Unrouted."
                  : bot.enabled
                    ? "Inbound mail is accepted."
                    : "New mail follows the unknown-recipient policy unless a forward-on-disable target is set. The address stays reserved."}
              </div>
            </div>
            <Switch checked={bot.enabled && !bot.archived} label="Receive mail" disabled={saving || bot.archived} onChange={(next) => void patch({ enabled: next }, next ? "Bot enabled" : "Bot disabled")} />
          </div>
        </div>
      </Panel>
      <Panel title="Danger zone" class="danger">
        {bot.archived ? (
          <div class="setting-row">
            <div>
              <div class="setting-title">Restore bot</div>
              <div class="setting-desc">Brings the mailbox back with the same id, notes, and mail. The old key stays dead until you rotate it.</div>
            </div>
            <Button variant="secondary" size="sm" loading={archiving} onClick={() => void restore()}>
              Restore
            </Button>
          </div>
        ) : (
          <div class="setting-row">
            <div>
              <div class="setting-title">Archive bot</div>
              <div class="setting-desc">Stops the mailbox and its key. Mail and notes stay, and you can restore it.</div>
            </div>
            <Button variant="danger" size="sm" onClick={() => setArchiveOpen(true)}>
              Archive
            </Button>
          </div>
        )}
      </Panel>
      <Modal
        open={archiveOpen}
        onClose={() => {
          setArchiveOpen(false);
          setConfirm("");
        }}
        title={`Archive ${bot.display_name || bot.id}?`}
        description="This is restorable. Mail and notes stay. The key stops working and must be rotated after restore. Type the bot id to confirm."
        footer={
          <>
            <Button variant="ghost" onClick={() => setArchiveOpen(false)}>
              Keep
            </Button>
            <Button variant="danger" loading={archiving} disabled={confirm !== bot.id} onClick={() => void archive()}>
              Archive bot
            </Button>
          </>
        }
      >
        <div class="form-stack">
          <div class="inline-alert">
            <AlertIcon size={14} /> Mail already in <span class="mono">{bot.address}</span> stays searchable. New mail is held in Unrouted until you restore it.
          </div>
          <Input mono value={confirm} placeholder={bot.id} aria-label="Bot id" onInput={(event) => setConfirm((event.currentTarget as HTMLInputElement).value)} />
        </div>
      </Modal>
    </>
  );
}
