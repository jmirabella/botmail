import { useMemo, useState } from "preact/hooks";
import { api, ApiError, type Bot } from "../api";
import { mailboxBots, useApp, visibleBots } from "../app";
import { domainTag, fullTime, plural, relativeTime } from "../format";
import { AlertIcon, BotIcon, ChevronRight, KeyIcon, PlusIcon, SearchIcon } from "../icons";
import { linkHandler, navigate } from "../router";
import { toast, toastError } from "../toast";
import { ArchiveToggle, Avatar, Badge, Button, CodeBlock, CopyButton, Field, Input, Modal, NotesHint, PageHeader, Select, SkeletonRows, EmptyState, Textarea } from "../ui";

export function WebhookBadge({ bot }: { bot: Bot }) {
  if (!bot.webhook_url) return <Badge tone="neutral">Not set</Badge>;
  if (bot.webhook_status === "failing") return <Badge tone="red" dot>Failing</Badge>;
  if (bot.webhook_status === "pending") return <Badge tone="amber" dot>Retrying</Badge>;
  if (bot.webhook_status === "ok") return <Badge tone="green" dot>Healthy</Badge>;
  return <Badge tone="blue" dot>Configured</Badge>;
}

export function StatusBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <Badge tone="green" dot>
      Active
    </Badge>
  ) : (
    <Badge tone="neutral" dot>
      Disabled
    </Badge>
  );
}

export function BotsPage() {
  const { bots, botsLoading, reloadBots, session, botName, multiDomain } = useApp();
  const [filter, setFilter] = useState("");
  const [domain, setDomain] = useState("");
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = mailboxBots(bots).filter((bot) => bot.archived).length;
  const listed = (showArchived ? mailboxBots(bots) : visibleBots(bots));
  const needle = filter.trim().toLowerCase();
  const rows = listed.filter(
    (bot) => (!domain || bot.domain === domain) && (!needle || `${bot.id} ${bot.display_name} ${bot.address} ${bot.notes}`.toLowerCase().includes(needle)),
  );
  const domainCount = new Set(listed.map((bot) => bot.domain)).size;
  const active = listed.filter((bot) => bot.enabled).length;
  const failing = listed.filter((bot) => bot.webhook_status === "failing").length;

  return (
    <div class="page">
      <PageHeader
        title="Bots"
        subtitle={
          <>
            {plural(listed.length, "mailbox")}{" "}
            {domainCount > 1 ? <>across {plural(domainCount, "domain")}</> : <>on <span class="mono">{listed[0]?.domain ?? session.mail_domain}</span></>} · {active} active
            {failing > 0 && <span class="text-red"> · {failing} webhook failing</span>}
          </>
        }
        actions={
          <>
            {multiDomain && (
              <Select
                class="select-sm"
                label="Domain"
                value={domain}
                onChange={setDomain}
                options={[{ value: "", label: "All domains" }, ...(session.domains ?? []).map((item) => ({ value: item.domain, label: item.domain }))]}
              />
            )}
            <ArchiveToggle pressed={showArchived} count={archivedCount} onToggle={() => setShowArchived((value) => !value)} />
            <Input prefix={<SearchIcon size={14} />} placeholder="Filter bots" value={filter} onInput={(event) => setFilter((event.currentTarget as HTMLInputElement).value)} aria-label="Filter bots" class="input-sm" />
            <Button variant="primary" icon={<PlusIcon size={14} stroke={2} />} onClick={() => setCreating(true)}>
              New bot
            </Button>
          </>
        }
      />
      <div class="table-card">
        <table class="table">
          <thead>
            <tr>
              <th>Bot</th>
              <th class="hide-sm">Address</th>
              <th>Status</th>
              <th class="hide-md">Last mail</th>
              <th class="hide-sm num">Unread</th>
              <th>Webhook</th>
              <th aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {rows.map((bot) => {
              const href = `/bots/${encodeURIComponent(bot.id)}`;
              return (
                <tr key={bot.id} class={bot.archived ? "row-link is-muted" : "row-link"} tabIndex={0} onClick={() => navigate(href)} onKeyDown={(event) => event.key === "Enter" && navigate(href)}>
                  <td>
                    <div class="cell-bot">
                      <Avatar seed={bot.id} label={bot.display_name} size={30} square />
                      <div class="cell-bot-text">
                        <div class="cell-title-row">
                          <span class="cell-title">{botName(bot.id)}</span>
                          <NotesHint notes={bot.notes} label={bot.address} />
                        </div>
                        <div class="cell-sub mono">
                          <span class="show-sm">{bot.address}</span>
                          <span class="hide-sm">{bot.id}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td class="hide-sm">
                    <div class="cell-address">
                      <span class="mono addr">
                        {bot.address_local}
                        <span class="addr-at">@{bot.domain}</span>
                      </span>
                      <CopyButton value={bot.address} label="Copy address" />
                    </div>
                  </td>
                  <td>
                    {bot.archived ? (
                      <Badge tone="amber" dot>
                        Archived
                      </Badge>
                    ) : (
                      <StatusBadge enabled={bot.enabled} />
                    )}
                  </td>
                  <td class="hide-md">
                    <span class="cell-muted" title={fullTime(bot.last_mail_at)}>
                      {bot.last_mail_at ? relativeTime(bot.last_mail_at) : "No mail yet"}
                    </span>
                  </td>
                  <td class="hide-sm num">{bot.unread_count > 0 ? <span class="count-pill">{bot.unread_count}</span> : <span class="cell-muted">0</span>}</td>
                  <td>
                    <WebhookBadge bot={bot} />
                  </td>
                  <td class="cell-chevron">
                    {bot.archived ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={(event) => {
                          event.stopPropagation();
                          void restoreBot(bot);
                        }}
                      >
                        Restore
                      </Button>
                    ) : (
                      <ChevronRight size={15} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {botsLoading && <SkeletonRows rows={6} />}
        {!botsLoading && rows.length === 0 && (
          <EmptyState
            icon={needle ? <SearchIcon size={18} /> : <BotIcon size={18} />}
            title={needle ? "No bots match" : "No bots yet"}
            body={needle ? `Nothing matches “${filter}”.` : "Create a mailbox to give a bot its own address, MCP key, and webhook."}
            action={
              !needle && (
                <Button variant="primary" icon={<PlusIcon size={14} />} onClick={() => setCreating(true)}>
                  New bot
                </Button>
              )
            }
          />
        )}
      </div>
      <CreateBotModal open={creating} onClose={() => setCreating(false)} onCreated={() => void reloadBots()} />
    </div>
  );

  async function restoreBot(bot: Bot) {
    try {
      await api(`/bots/${encodeURIComponent(bot.id)}/restore`, { method: "POST", body: {} });
      toast(`Restored ${bot.display_name || bot.id}`, { detail: "Rotate its key before connecting. The previous key no longer works." });
      await reloadBots();
    } catch (error) {
      toastError(error, "Could not restore bot");
    }
  }
}

const LOCAL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ID_PATTERN = /^[a-z][a-z0-9._-]{0,62}$/;

function wellFormed(value: string): boolean {
  return !value.includes("..") && !value.endsWith(".");
}

/** Mirrors the Worker: herald, then herald.desk, then herald.bot-desk-email, then herald-2. */
function suggestId(local: string, domain: string, taken: Set<string>): string {
  const base = /^[a-z]/.test(local) ? local : `bot-${local}`;
  const tidy = (value: string) => value.slice(0, 63).replace(/[._-]+$/, "");
  const candidates = [base, `${base}.${domainTag(domain)}`, `${base}.${domain.replaceAll(".", "-")}`];
  for (let n = 2; n < 50; n += 1) candidates.push(`${tidy(base).slice(0, 59)}-${n}`);
  return candidates.map(tidy).find((id) => ID_PATTERN.test(id) && !taken.has(id)) ?? base;
}

type Conflict = { message: string; settingsLink?: boolean };

function findConflict(bots: Bot[], local: string, domain: string, uniqueNames: boolean): Conflict | null {
  if (!local) return null;
  const same = bots.find((bot) => bot.id !== "_unrouted" && bot.address_local === local && bot.domain === domain);
  if (same?.archived) return { message: `${local}@${domain} is taken by archived bot ${same.display_name || same.id} (${same.id}). Restore it?` };
  if (same) return { message: `${local}@${domain} is already taken by ${same.display_name || same.id} (${same.id}).` };
  if (!uniqueNames) return null;
  const others = bots.filter((bot) => bot.id !== "_unrouted" && bot.address_local === local && bot.domain !== domain);
  const other = others.find((bot) => !bot.archived) ?? others.find((bot) => bot.archived);
  if (other?.archived) return { message: `The name “${local}” is taken by archived bot ${other.display_name || other.id} (${other.id}) at ${other.address}. Restore it?` };
  if (other) {
    return {
      message: `A bot named “${local}” already exists at ${other.address}. Unique bot names is on, so a name can be used on one domain only.`,
      settingsLink: true,
    };
  }
  return null;
}

function CreateBotModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { session, bots, multiDomain } = useApp();
  const domains = (session.domains ?? []).filter((item) => item.enabled);
  const fallback = domains.find((item) => item.is_default)?.domain ?? session.mail_domain;
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState(fallback);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [customId, setCustomId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Conflict | null>(null);
  const [minted, setMinted] = useState<{ id: string; address: string; authorization: string } | null>(null);
  const taken = useMemo(() => new Set(bots.map((bot) => bot.id)), [bots]);
  const suggested = local ? suggestId(local, domain, taken) : "";
  const conflict = findConflict(bots, local, domain, session.unique_bot_names);
  const localValid = LOCAL_PATTERN.test(local) && wellFormed(local);
  const idValid = !customId || (ID_PATTERN.test(customId) && wellFormed(customId));
  const idTaken = Boolean(customId) && taken.has(customId);
  const valid = localValid && idValid && !idTaken && !conflict;
  const shown = conflict ?? error;
  const close = () => {
    setLocal("");
    setDomain(fallback);
    setName("");
    setNotes("");
    setCustomId("");
    setMinted(null);
    setError(null);
    onClose();
  };
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const body = await api<Bot & { authorization: string }>("/bots", {
        method: "POST",
        body: { local_part: local, domain, id: customId || undefined, display_name: name.trim() || undefined, notes: notes.trim() || undefined },
      });
      setMinted({ id: body.id, address: body.address, authorization: body.authorization });
      toast(`Created ${body.address}`);
      onCreated();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ message, settingsLink: caught instanceof ApiError && caught.code === "name_taken" });
      if (!(caught instanceof ApiError && caught.status === 409)) toastError(caught, "Could not create bot");
    } finally {
      setBusy(false);
    }
  };
  if (minted) {
    return (
      <Modal
        open={open}
        onClose={close}
        title="Mailbox created"
        description={<>On the shared BotMail connector, add an account named <span class="mono">{minted.id}</span> for <span class="mono addr">{minted.address}</span>, then click Connect and pick or create that mailbox. The script key below is shown once for bridges and scripts. A remote connector does not use it.</>}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Done
            </Button>
            <Button variant="primary" onClick={() => {
              close();
              navigate(`/bots/${encodeURIComponent(minted.id)}`);
            }}>
              Open Connect panel
            </Button>
          </>
        }
      >
        <div class="reveal">
          <div class="reveal-head">
            <KeyIcon size={14} /> Script key, shown once
          </div>
          <div class="reveal-value mono">{minted.authorization}</div>
          <CopyButton value={minted.authorization} label="Copy script key" text="Copy key" size="md" />
        </div>
        <CodeBlock title="Remote MCP connector" code={`Name:      BotMail\nURL:       ${session.mcp_url || "https://<publicHost>/mcp"}\nTransport: Streamable HTTP\nHeaders:   none\nAccount:   ${minted.id}\nThen click Connect and sign in, and pick or create ${minted.id}.`} />
      </Modal>
    );
  }
  return (
    <Modal
      open={open}
      onClose={close}
      width={520}
      title="New bot"
      description="Each bot gets its own address. A remote connector signs in through Access. The script key is only for bridges and scripts."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()}>
            Create bot
          </Button>
        </>
      }
    >
      <form
        class="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {multiDomain && (
          <Field label="Domain" htmlFor="new-bot-domain">
            <Select label="Domain" value={domain} onChange={(next) => { setDomain(next); setError(null); }} options={domains.map((item) => ({ value: item.domain, label: item.is_default ? `${item.domain} (default)` : item.domain }))} />
          </Field>
        )}
        <Field
          label="Address"
          htmlFor="new-bot-local"
          hint={local && !localValid ? <span class="text-red">Lowercase letters, digits, dot, - and _.</span> : "The part before the @. Also the default bot id."}
        >
          <Input
            id="new-bot-local"
            mono
            value={local}
            placeholder="rating"
            suffix={`@${domain}`}
            onInput={(event) => {
              setLocal((event.currentTarget as HTMLInputElement).value.trim().toLowerCase());
              setError(null);
            }}
            autoComplete="off"
            aria-invalid={Boolean(conflict)}
          />
        </Field>
        <div class="form-row">
          <Field label="Display name" htmlFor="new-bot-name">
            <Input id="new-bot-name" value={name} placeholder="Rating" onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)} autoComplete="off" />
          </Field>
          <Field
            label="Bot id"
            htmlFor="new-bot-id"
            hint={idTaken ? <span class="text-red">That id is in use.</span> : customId && !idValid ? <span class="text-red">Starts with a letter; a-z, 0-9, . - _</span> : suggested && suggested !== local ? `${local} is taken, so ${suggested}` : "Unique across all domains"}
          >
            <Input id="new-bot-id" mono value={customId} placeholder={suggested || "rating"} onInput={(event) => setCustomId((event.currentTarget as HTMLInputElement).value.trim().toLowerCase())} autoComplete="off" />
          </Field>
        </div>
        <Field label="Notes" htmlFor="new-bot-notes" hint="Optional. Shown on hover in every mailbox list.">
          <Textarea id="new-bot-notes" value={notes} onInput={setNotes} rows={3} maxLength={2000} placeholder="What this mailbox is for." />
        </Field>
        {shown && (
          <div class="inline-alert" role="alert">
            <AlertIcon size={14} />
            <span>
              {shown.message}
              {shown.settingsLink && (
                <>
                  {" "}
                  <a class="inline-link" href="/settings" onClick={(event) => { close(); linkHandler("/settings")(event); }}>
                    Change in Settings
                  </a>
                </>
              )}
            </span>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
