import { useEffect, useMemo, useState } from "preact/hooks";
import { api, ApiError, type SendPolicy, type Settings } from "../api";
import { useApp } from "../app";
import { AlertIcon, LockIcon, SendIcon, ShieldIcon, XIcon } from "../icons";
import { toast, toastError } from "../toast";
import { Avatar, Badge, Button, CopyField, cx, Field, Input, LinkButton, PageHeader, RadioCard, Switch } from "../ui";

type Draft = {
  send_policy: SendPolicy;
  allowlist: string[];
  spam_junk: boolean;
  spam_score_threshold: number;
  inbound_rate_limit: number;
  inbound_bot_rate_limit: number;
  inbound_auto_reply_limit: number;
  outbound_daily_stamp_limit: number;
  inbound_allowlist: string[];
  inbound_blocklist: string[];
  brand_name: string;
  brand_logo: string;
  brand_accent: string;
};

function draftFrom(settings: Settings): Draft {
  return {
    send_policy: settings.send_policy,
    allowlist: settings.allowlist_extra,
    spam_junk: settings.spam_score_threshold != null,
    spam_score_threshold: settings.spam_score_threshold ?? 4,
    inbound_rate_limit: settings.inbound_rate_limit,
    inbound_bot_rate_limit: settings.inbound_bot_rate_limit,
    inbound_auto_reply_limit: settings.inbound_auto_reply_limit,
    outbound_daily_stamp_limit: settings.outbound_daily_stamp_limit,
    inbound_allowlist: settings.inbound_allowlist,
    inbound_blocklist: settings.inbound_blocklist,
    brand_name: settings.brand_name,
    brand_logo: settings.brand_logo,
    brand_accent: settings.brand_accent,
  };
}

export function SettingsPage() {
  const { session, setSession } = useApp();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(session));
  const [entry, setEntry] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(draftFrom(session)), [session]);
  const base = useMemo(() => draftFrom(session), [session]);
  const dirty = JSON.stringify(base) !== JSON.stringify(draft);
  const accentValid = /^#[0-9a-fA-F]{6}$/.test(draft.brand_accent);
  const logoValid = !draft.brand_logo || draft.brand_logo.startsWith("https://");
  const rateValid = Number.isInteger(draft.inbound_rate_limit) && draft.inbound_rate_limit >= 1 && draft.inbound_rate_limit <= 1000;
  const botRateValid = Number.isInteger(draft.inbound_bot_rate_limit) && draft.inbound_bot_rate_limit >= 1 && draft.inbound_bot_rate_limit <= 1000;
  const autoReplyValid = Number.isInteger(draft.inbound_auto_reply_limit) && draft.inbound_auto_reply_limit >= 1 && draft.inbound_auto_reply_limit <= 1000;
  const dailyStampValid = Number.isInteger(draft.outbound_daily_stamp_limit) && draft.outbound_daily_stamp_limit >= 1 && draft.outbound_daily_stamp_limit <= 10000;
  const spamValid = !draft.spam_junk || (Number.isInteger(draft.spam_score_threshold) && draft.spam_score_threshold >= 1 && draft.spam_score_threshold <= 5);
  const configEntries = session.allowlist.filter((item) => !session.allowlist_extra.includes(item));

  useEffect(() => {
    if (accentValid) document.documentElement.style.setProperty("--accent", draft.brand_accent);
    return () => document.documentElement.style.setProperty("--accent", session.brand_accent);
  }, [draft.brand_accent]);

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        allowlist: draft.allowlist,
        brand_name: draft.brand_name,
        brand_logo: draft.brand_logo,
        brand_accent: draft.brand_accent,
      };
      if (draft.send_policy !== base.send_policy) body.send_policy = draft.send_policy;
      if (draft.inbound_rate_limit !== base.inbound_rate_limit) body.inbound_rate_limit = draft.inbound_rate_limit;
      if (draft.inbound_bot_rate_limit !== base.inbound_bot_rate_limit) body.inbound_bot_rate_limit = draft.inbound_bot_rate_limit;
      if (draft.inbound_auto_reply_limit !== base.inbound_auto_reply_limit) body.inbound_auto_reply_limit = draft.inbound_auto_reply_limit;
      if (draft.outbound_daily_stamp_limit !== base.outbound_daily_stamp_limit) body.outbound_daily_stamp_limit = draft.outbound_daily_stamp_limit;
      if (draft.spam_junk !== base.spam_junk || draft.spam_score_threshold !== base.spam_score_threshold) {
        body.spam_score_threshold = draft.spam_junk ? draft.spam_score_threshold : null;
      }
      if (JSON.stringify(draft.inbound_allowlist) !== JSON.stringify(base.inbound_allowlist)) body.inbound_allowlist = draft.inbound_allowlist;
      if (JSON.stringify(draft.inbound_blocklist) !== JSON.stringify(base.inbound_blocklist)) body.inbound_blocklist = draft.inbound_blocklist;
      const next = await api<Settings>("/settings", { method: "PUT", body });
      setSession({ ...session, ...next });
      toast("Settings saved");
    } catch (error) {
      toastError(error, "Could not save settings");
    } finally {
      setSaving(false);
    }
  };

  const useConfigInbound = async () => {
    try {
      const next = await api<Settings>("/settings", { method: "PUT", body: { inbound_policy_source: "config" } });
      setSession({ ...session, ...next });
      toast("Inbound checks follow the group config again");
    } catch (error) {
      toastError(error);
    }
  };

  const useConfigPolicy = async () => {
    try {
      const next = await api<Settings>("/settings", { method: "PUT", body: { send_policy_source: "config" } });
      setSession({ ...session, ...next });
      toast("Send policy follows the group config again");
    } catch (error) {
      toastError(error);
    }
  };

  const [uniqueBusy, setUniqueBusy] = useState(false);
  const [uniqueError, setUniqueError] = useState("");
  const saveUnique = async (value: boolean | null) => {
    setUniqueBusy(true);
    setUniqueError("");
    try {
      const next = await api<Settings>("/settings", { method: "PUT", body: { unique_bot_names: value } });
      setSession({ ...session, ...next });
      toast(value === null ? "Unique bot names follows the group config again" : value ? "Bot names are unique across domains" : "Bot names can repeat across domains");
    } catch (error) {
      if (error instanceof ApiError && error.code === "duplicates") setUniqueError(error.message);
      else toastError(error, "Could not save setting");
    } finally {
      setUniqueBusy(false);
    }
  };

  const addEntry = () => {
    const value = entry.trim().toLowerCase();
    if (!value || draft.allowlist.includes(value)) return setEntry("");
    setDraft({ ...draft, allowlist: [...draft.allowlist, value] });
    setEntry("");
  };

  return (
    <div class="page page-narrow">
      <PageHeader title="Settings" subtitle="Outbound policy, inbound sender checks, branding, and access for this deployment." />
      <div class="settings">
        <SettingsSection title="Send policy" desc="Decides whether bots can email outside your domain without a human approving each message.">
          <div class="radio-grid radio-grid-2" role="radiogroup" aria-label="Send policy">
            <RadioCard
              checked={draft.send_policy === "approval"}
              onSelect={() => setDraft({ ...draft, send_policy: "approval" })}
              icon={<ShieldIcon size={14} />}
              title="Approval"
              body="Mail to the domain and allowlist sends immediately. Everything else waits in the approval queue."
            />
            <RadioCard
              checked={draft.send_policy === "direct"}
              onSelect={() => setDraft({ ...draft, send_policy: "direct" })}
              icon={<SendIcon size={14} />}
              title="Direct"
              body="Every recipient sends immediately. Use only when another gate reviews outbound mail."
            />
          </div>
          <div class="setting-foot">
            <span>
              Source:{" "}
              {session.send_policy_source === "dashboard" ? (
                <Badge tone="accent">Dashboard override</Badge>
              ) : (
                <Badge tone="neutral">
                  Group config <span class="mono">SEND_POLICY</span>
                </Badge>
              )}
            </span>
            {session.send_policy_source === "dashboard" && (
              <Button size="sm" variant="ghost" onClick={() => void useConfigPolicy()}>
                Use config value
              </Button>
            )}
          </div>
        </SettingsSection>

        <SettingsSection title="Allowlist" desc="Domains or addresses that skip approval. Entries from the group config are read-only here.">
          <div class="tags-input">
            {configEntries.map((item) => (
              <span class="tag-chip is-locked" key={`config-${item}`} title="From group config">
                <LockIcon size={11} /> {item}
              </span>
            ))}
            {draft.allowlist.map((item) => (
              <span class="tag-chip" key={item}>
                {item}
                <button aria-label={`Remove ${item}`} onClick={() => setDraft({ ...draft, allowlist: draft.allowlist.filter((value) => value !== item) })}>
                  <XIcon size={11} />
                </button>
              </span>
            ))}
            <input
              value={entry}
              placeholder={draft.allowlist.length || configEntries.length ? "Add another" : "partner.com or ops@partner.com"}
              aria-label="Add allowlist entry"
              onInput={(event) => setEntry((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === ",") {
                  event.preventDefault();
                  addEntry();
                }
                if (event.key === "Backspace" && !entry && draft.allowlist.length) {
                  setDraft({ ...draft, allowlist: draft.allowlist.slice(0, -1) });
                }
              }}
              onBlur={addEntry}
            />
          </div>
        </SettingsSection>

        <SettingsSection title="Inbound checks" desc="A BotMail From, Sender, or envelope sender is delivered only with a valid stamp from this Worker. A Cloudflare DMARC pass is labeled Auth pass, in a neutral badge, and that label is hidden while the message is quarantined. Other mail stays unverified.">
          <Field label="Sender rate limit" htmlFor="inbound-rate" hint={rateValid ? "Messages per sender per mailbox each hour. Extra mail is quarantined as rate limited. The allowlist skips this limit." : <span class="text-red">Use an integer from 1 to 1000</span>}>
            <Input
              id="inbound-rate"
              type="number"
              min={1}
              max={1000}
              value={String(draft.inbound_rate_limit)}
              onInput={(event) => setDraft({ ...draft, inbound_rate_limit: Number((event.currentTarget as HTMLInputElement).value) })}
            />
          </Field>
          <Field label="Bot pair rate limit" htmlFor="inbound-bot-rate" hint={botRateValid ? "Stamped messages from one sender to one mailbox each hour. The default is 30." : <span class="text-red">Use an integer from 1 to 1000</span>}>
            <Input
              id="inbound-bot-rate"
              type="number"
              min={1}
              max={1000}
              value={String(draft.inbound_bot_rate_limit)}
              onInput={(event) => setDraft({ ...draft, inbound_bot_rate_limit: Number((event.currentTarget as HTMLInputElement).value) })}
            />
          </Field>
          <Field label="Auto-reply limit" htmlFor="inbound-auto-reply" hint={autoReplyValid ? "Bot sends to one BotMail mailbox in the window (default one hour). A dashboard approval does not count. The default is 20." : <span class="text-red">Use an integer from 1 to 1000</span>}>
            <Input
              id="inbound-auto-reply"
              type="number"
              min={1}
              max={1000}
              value={String(draft.inbound_auto_reply_limit)}
              onInput={(event) => setDraft({ ...draft, inbound_auto_reply_limit: Number((event.currentTarget as HTMLInputElement).value) })}
            />
          </Field>
          <Field label="Daily stamp limit" htmlFor="outbound-daily-stamp" hint={dailyStampValid ? "Stamped BotMail recipients one bot may send in a day, including mail a person approved. The default is 200." : <span class="text-red">Use an integer from 1 to 10000</span>}>
            <Input
              id="outbound-daily-stamp"
              type="number"
              min={1}
              max={10000}
              value={String(draft.outbound_daily_stamp_limit)}
              onInput={(event) => setDraft({ ...draft, outbound_daily_stamp_limit: Number((event.currentTarget as HTMLInputElement).value) })}
            />
          </Field>
          <div class="setting-row setting-row-card">
            <div>
              <div class="setting-title">Junk folder</div>
              <div class="setting-desc">A score at or above the threshold goes to Junk and does not wake the bot. Off leaves every score in the inbox.</div>
            </div>
            <Switch
              checked={draft.spam_junk}
              label="Move high spam scores to Junk"
              onChange={(next) => setDraft({ ...draft, spam_junk: next, spam_score_threshold: draft.spam_score_threshold || 4 })}
            />
          </div>
          <Field
            label="Spam score threshold"
            htmlFor="spam-score-threshold"
            hint={
              draft.spam_junk ? (
                spamValid ? (
                  "Cloudflare X-Cf-Spamh-Score, from 0 (least likely) to 5. Mail at or above this score goes to Junk. Default 4. Quarantine still wins, and stamped BotMail mail stays in the inbox."
                ) : (
                  <span class="text-red">Use an integer from 1 to 5</span>
                )
              ) : (
                "Off. The score is still stored. Nothing is moved to Junk."
              )
            }
          >
            <Input
              id="spam-score-threshold"
              type="number"
              min={1}
              max={5}
              disabled={!draft.spam_junk}
              value={String(draft.spam_score_threshold)}
              onInput={(event) => setDraft({ ...draft, spam_score_threshold: Number((event.currentTarget as HTMLInputElement).value) })}
            />
          </Field>
          <div class="setting-foot">
            <span>
              Source:{" "}
              {session.inbound_policy_source === "dashboard" ? (
                <Badge tone="accent">Dashboard override</Badge>
              ) : (
                <Badge tone="neutral">Group config</Badge>
              )}
            </span>
            {session.inbound_policy_source === "dashboard" && (
              <Button size="sm" variant="ghost" onClick={() => void useConfigInbound()}>
                Use config value
              </Button>
            )}
          </div>
        </SettingsSection>

        <SettingsSection title="Inbound allowlist" desc="Addresses or domains that skip the hourly rate limit. A BotMail domain is refused. This list does not waive the unstamped-sender quarantine. A block still wins.">
          <TagList
            label="Add inbound allowlist entry"
            placeholder="partner.com or ops@partner.com"
            values={draft.inbound_allowlist}
            onChange={(inbound_allowlist) => setDraft({ ...draft, inbound_allowlist })}
          />
        </SettingsSection>

        <SettingsSection title="Inbound blocklist" desc="Addresses or domains. Matching mail is quarantined and kept. Nothing is deleted.">
          <TagList
            label="Add inbound blocklist entry"
            placeholder="spam.example or bad@spam.example"
            values={draft.inbound_blocklist}
            onChange={(inbound_blocklist) => setDraft({ ...draft, inbound_blocklist })}
          />
        </SettingsSection>

        <SettingsSection title="Bot names" desc="Addresses are always unique per domain. This decides whether a name can repeat on another domain.">
          <div class="setting-row setting-row-card">
            <div>
              <div class="setting-title">Unique bot names</div>
              <div class="setting-desc">
                {session.unique_bot_names ? (
                  <>
                    One <span class="mono">rating</span> bot across every domain. Creating <span class="mono">rating@</span> on a second domain is refused.
                  </>
                ) : (
                  <>
                    <span class="mono">herald@bot.example.com</span> and <span class="mono">herald@desk.example.com</span> can both exist as separate bots.
                  </>
                )}
              </div>
            </div>
            <Switch checked={session.unique_bot_names} label="Unique bot names" disabled={uniqueBusy} onChange={(next) => void saveUnique(next)} />
          </div>
          {uniqueError && (
            <div class="inline-alert" role="alert">
              <AlertIcon size={14} />
              <span>{uniqueError}</span>
            </div>
          )}
          <div class="setting-foot">
            <span>
              Source:{" "}
              {session.unique_bot_names_source === "dashboard" ? (
                <Badge tone="accent">Dashboard override</Badge>
              ) : (
                <Badge tone="neutral">
                  Group config <span class="mono">uniqueBotNames</span>
                </Badge>
              )}
            </span>
            {session.unique_bot_names_source === "dashboard" && (
              <Button size="sm" variant="ghost" disabled={uniqueBusy} onClick={() => void saveUnique(null)}>
                Use config value ({session.unique_bot_names_config ? "on" : "off"})
              </Button>
            )}
          </div>
        </SettingsSection>

        <SettingsSection title="Branding" desc="Shown in the sidebar, page titles, and connector names.">
          <div class="form-grid">
            <Field label="Product name" htmlFor="brand-name">
              <Input id="brand-name" value={draft.brand_name} onInput={(event) => setDraft({ ...draft, brand_name: (event.currentTarget as HTMLInputElement).value })} />
            </Field>
            <Field label="Accent" htmlFor="brand-accent" hint={accentValid ? undefined : <span class="text-red">Use #rrggbb</span>}>
              <div class="color-input">
                <input type="color" aria-label="Pick accent" value={accentValid ? draft.brand_accent : "#7aa2ff"} onInput={(event) => setDraft({ ...draft, brand_accent: (event.currentTarget as HTMLInputElement).value })} />
                <Input id="brand-accent" mono value={draft.brand_accent} onInput={(event) => setDraft({ ...draft, brand_accent: (event.currentTarget as HTMLInputElement).value })} />
              </div>
            </Field>
            <Field label="Logo URL" htmlFor="brand-logo" hint={logoValid ? "Optional. Must be https." : <span class="text-red">Logo must be an https URL</span>}>
              <Input id="brand-logo" mono value={draft.brand_logo} placeholder="https://example.com/logo.svg" onInput={(event) => setDraft({ ...draft, brand_logo: (event.currentTarget as HTMLInputElement).value })} />
            </Field>
          </div>
          <div class="brand-preview">
            <span class="eyebrow">Preview</span>
            <div class="brand-preview-row">
              {draft.brand_logo && logoValid ? <img class="brand-logo" src={draft.brand_logo} alt="" /> : <span class="brand-glyph" />}
              <span class="brand-name">{draft.brand_name || "BotMail"}</span>
              <span class="preview-accent">
                <span class="unread-dot" /> 3 unread
              </span>
              <Button size="sm" variant="accent">
                Accent button
              </Button>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection title="Access" desc="The dashboard and its API accept only Cloudflare Access identities. API keys are for MCP and scripts.">
          <div class="access-card">
            <Avatar seed={session.email || "user"} label={session.email} size={32} />
            <div>
              <div class="access-email">{session.email}</div>
              <div class="access-meta">
                <ShieldIcon size={12} /> Verified Cloudflare Access JWT · <span class="mono">{session.admin_host || location.host}</span>
              </div>
            </div>
            <a class="btn btn-ghost btn-sm" href="/cdn-cgi/access/logout">
              Sign out
            </a>
          </div>
          <div class="form-grid">
            <Field label="MCP endpoint">
              <CopyField value={session.mcp_url} label="Copy MCP URL" placeholder="Set publicHost to publish an MCP URL" />
            </Field>
            <Field label="Default mail domain" hint={<>{(session.domains?.length ?? 1) > 1 ? `${session.domains.length} domains in use. ` : ""}Add or disable domains on the Domains page.</>}>
              <div class="field-inline">
                <CopyField value={session.mail_domain} label="Copy mail domain" />
                <LinkButton href="/domains" size="sm" variant="ghost">
                  Domains
                </LinkButton>
              </div>
            </Field>
          </div>
        </SettingsSection>
      </div>
      <div class={cx("save-bar", dirty && "is-visible")} aria-hidden={!dirty}>
        <span>Unsaved changes</span>
        <div class="save-bar-actions">
          <Button size="sm" variant="ghost" onClick={() => setDraft(base)}>
            Discard
          </Button>
          <Button size="sm" variant="primary" loading={saving} disabled={!accentValid || !logoValid || !rateValid || !botRateValid || !autoReplyValid || !dailyStampValid || !spamValid} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}

function TagList({ label, placeholder, values, onChange }: { label: string; placeholder: string; values: string[]; onChange: (next: string[]) => void }) {
  const [entry, setEntry] = useState("");
  const add = () => {
    const value = entry.trim().toLowerCase();
    if (!value || values.includes(value)) return setEntry("");
    onChange([...values, value]);
    setEntry("");
  };
  return (
    <div class="tags-input">
      {values.map((item) => (
        <span class="tag-chip" key={item}>
          {item}
          <button aria-label={`Remove ${item}`} onClick={() => onChange(values.filter((value) => value !== item))}>
            <XIcon size={11} />
          </button>
        </span>
      ))}
      <input
        value={entry}
        placeholder={values.length ? "Add another" : placeholder}
        aria-label={label}
        onInput={(event) => setEntry((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add();
          }
          if (event.key === "Backspace" && !entry && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
}

function SettingsSection({ title, desc, children }: { title: string; desc: string; children: preact.ComponentChildren }) {
  return (
    <section class="settings-section">
      <div class="settings-label">
        <h2>{title}</h2>
        <p>{desc}</p>
      </div>
      <div class="settings-control">{children}</div>
    </section>
  );
}
