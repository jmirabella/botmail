import { useState } from "preact/hooks";
import { api, ApiError, type CheckState, type DomainView } from "../api";
import { useApp } from "../app";
import { fullTime, plural, relativeTime } from "../format";
import { AlertIcon, ChevronDown, GlobeIcon, KeyIcon, PlusIcon, RefreshIcon, TrashIcon } from "../icons";
import { toast, toastError } from "../toast";
import { ArchiveToggle, Badge, Button, CheckList, checkName, CodeBlock, cx, EmptyState, ErrorNote, Field, Input, Modal, PageHeader, SkeletonRows, StateBadge, Switch, useResource } from "../ui";

type DomainList = { domains: DomainView[]; api_configured: boolean };

const DOMAIN_PATTERN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function ready(view: DomainView): boolean {
  return view.enabled && view.routing === "ok" && view.sending === "ok" && view.dns === "ok";
}

export function DomainsPage() {
  const { session, setSession, reloadBots } = useApp();
  const list = useResource(() => api<DomainList>("/domains?include_archived=1"), []);
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const all = list.data?.domains ?? [];
  const archivedCount = all.filter((view) => view.archived).length;
  const domains = showArchived ? all : all.filter((view) => !view.archived);
  const apiConfigured = list.data?.api_configured ?? session.cf_api_configured;

  const sync = (next: DomainView[]) => {
    list.mutate((current) => ({ api_configured: current?.api_configured ?? apiConfigured, domains: next }));
    setSession({ ...session, domains: next.filter((item) => !item.archived).map(({ domain, is_default, enabled }) => ({ domain, is_default, enabled })) });
  };
  const replace = (view: DomainView) => sync(all.some((item) => item.domain === view.domain) ? all.map((item) => (item.domain === view.domain ? view : item)) : [...all, view]);
  const readyCount = domains.filter(ready).length;

  return (
    <div class="page page-narrow">
      <PageHeader
        title="Domains"
        subtitle={
          list.data ? (
            <>
              {plural(domains.length, "domain")} · {readyCount} ready · {apiConfigured ? "Provisioned through the Cloudflare API" : "Manual setup"}
            </>
          ) : (
            "Mail domains this deployment receives and sends for."
          )
        }
        actions={
          <>
            <ArchiveToggle pressed={showArchived} count={archivedCount} onToggle={() => setShowArchived((value) => !value)} />
            <Button variant="primary" icon={<PlusIcon size={14} stroke={2} />} onClick={() => setAdding(true)}>
              Add domain
            </Button>
          </>
        }
      />
      {!apiConfigured && list.data && (
        <div class="callout">
          <span class="callout-icon">
            <KeyIcon size={14} />
          </span>
          <div>
            <div class="callout-title">No Cloudflare API token</div>
            <p>
              BotMail can still add domains, but you run the Email Routing and Email Sending steps yourself. Each domain lists them below. Store a <span class="mono">CF_API_TOKEN</span> Worker secret to let BotMail enable routing, onboard sending, and verify DNS for you.
            </p>
          </div>
        </div>
      )}
      {list.error && <ErrorNote error={list.error} onRetry={() => void list.reload()} />}
      {list.loading && !list.data && <SkeletonRows rows={3} avatar={false} />}
      <div class="domain-list">
        {domains.map((view) => (
          <DomainCard key={view.domain} view={view} onChange={replace} onBotsChanged={() => void reloadBots()} />
        ))}
      </div>
      {list.data && domains.length === 0 && (
        <EmptyState icon={<GlobeIcon size={18} />} title="No domains yet" body="Add the domain your bots should receive mail on." />
      )}
      <AddDomainModal open={adding} apiConfigured={apiConfigured} onClose={() => setAdding(false)} onAdded={replace} />
    </div>
  );
}

function StatusTile({ label, state, detail }: { label: string; state: CheckState; detail: string }) {
  return (
    <div class={cx("domain-tile", `is-${state}`)}>
      <div class="domain-tile-label">{label}</div>
      <StateBadge state={state} />
      <div class="domain-tile-detail">{detail}</div>
    </div>
  );
}

function tileDetail(view: DomainView, group: "routing" | "sending" | "dns"): string {
  const checks = view.checks.filter((item) => item.group === group);
  const open = checks.filter((item) => item.state !== "ok");
  if (!checks.length) return "Not checked yet";
  if (!open.length) return group === "dns" ? "MX, SPF, DKIM, DMARC found" : group === "routing" ? "Catch-all reaches this Worker" : "Onboarded for send_email";
  if (open.length === 1) return open[0]!.detail;
  return `Missing ${open.map(checkName).join(", ")}`;
}

function DomainCard({ view, onChange, onBotsChanged }: { view: DomainView; onChange: (view: DomainView) => void; onBotsChanged: () => void }) {
  const [open, setOpen] = useState(view.enabled && !ready(view));
  const [busy, setBusy] = useState<"" | "check" | "toggle" | "delete">("");
  const [confirming, setConfirming] = useState(false);

  const run = async (kind: "check" | "toggle" | "delete", action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } catch (error) {
      toastError(error, kind === "check" ? "Recheck failed" : kind === "toggle" ? "Could not update domain" : "Could not archive domain");
    } finally {
      setBusy("");
    }
  };
  const recheck = () =>
    run("check", async () => {
      const body = await api<{ domain: DomainView }>(`/domains/${encodeURIComponent(view.domain)}/check`, { method: "POST" });
      onChange(body.domain);
      setOpen(body.domain.enabled && !ready(body.domain));
      toast(ready(body.domain) ? `${view.domain} is ready` : `Rechecked ${view.domain}`);
    });
  const toggle = (enabled: boolean) =>
    run("toggle", async () => {
      const body = await api<{ domain: DomainView }>(`/domains/${encodeURIComponent(view.domain)}`, { method: "PATCH", body: { enabled } });
      onChange(body.domain);
      onBotsChanged();
      toast(enabled ? `${view.domain} enabled` : `${view.domain} disabled`, { detail: enabled ? undefined : "Inbound mail is rejected and its bots cannot send." });
    });
  const archive = () =>
    run("delete", async () => {
      await api(`/domains/${encodeURIComponent(view.domain)}`, { method: "DELETE" });
      onChange({ ...view, archived: true, enabled: false, deleted_at: new Date().toISOString() });
      onBotsChanged();
      toast(`Archived ${view.domain}`, { detail: "Restore it any time. Mail and mailboxes stay." });
    });
  const restore = () =>
    run("delete", async () => {
      const body = await api<{ domain: DomainView }>(`/domains/${encodeURIComponent(view.domain)}/restore`, { method: "POST", body: {} });
      onChange(body.domain);
      onBotsChanged();
      toast(`Restored ${view.domain}`);
    });

  const showManual = view.mode === "manual" && !ready(view);
  return (
    <section class={cx("domain-card", !view.enabled && "is-disabled")}>
      <header class="domain-head">
        <span class="domain-glyph">
          <GlobeIcon size={15} />
        </span>
        <div class="domain-title">
          <div class="domain-name-row">
            <span class="domain-name mono">{view.domain}</span>
            {view.is_default && <Badge tone="accent">Default</Badge>}
            {view.archived ? <Badge tone="amber">Archived</Badge> : !view.enabled && <Badge tone="neutral">Disabled</Badge>}
          </div>
          <div class="domain-meta">
            <span>{plural(view.bot_count, "bot")}</span>
            <span>
              Zone <span class="mono">{view.zone_name ?? "unknown"}</span>
            </span>
            <span>{view.mode === "api" ? "API" : "Manual"}</span>
            <span title={fullTime(view.checked_at)}>{view.checked_at ? `Checked ${relativeTime(view.checked_at)}` : "Never checked"}</span>
          </div>
        </div>
        <div class="domain-actions">
          <Button size="sm" variant="ghost" icon={<RefreshIcon size={13} />} loading={busy === "check"} onClick={() => void recheck()}>
            Recheck
          </Button>
          {view.archived ? (
            <Button size="sm" variant="secondary" loading={busy === "delete"} onClick={() => void restore()}>
              Restore
            </Button>
          ) : (
            <span class="domain-switch" title={view.is_default ? "The default domain cannot be disabled" : view.enabled ? "Disable domain" : "Enable domain"}>
              <Switch checked={view.enabled} label={`${view.enabled ? "Disable" : "Enable"} ${view.domain}`} disabled={view.is_default || busy !== ""} onChange={(next) => void toggle(next)} />
            </span>
          )}
        </div>
      </header>
      <div class="domain-tiles">
        <StatusTile label="Routing" state={view.routing} detail={tileDetail(view, "routing")} />
        <StatusTile label="Sending" state={view.sending} detail={tileDetail(view, "sending")} />
        <StatusTile label="DNS" state={view.dns} detail={tileDetail(view, "dns")} />
      </div>
      {view.error && (
        <div class="inline-alert domain-error" role="alert">
          <AlertIcon size={14} />
          <span>{view.error}</span>
        </div>
      )}
      <button type="button" class={cx("domain-toggle", open && "is-open")} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown size={14} />
        {open ? "Hide checks" : `Show ${plural(view.checks.length, "check")}`}
        {showManual && <span class="domain-toggle-hint">Manual steps inside</span>}
      </button>
      {open && (
        <div class="domain-body">
          {view.checks.length > 0 ? <CheckList checks={view.checks} /> : <p class="muted-copy">Press Recheck to look up this domain's DNS.</p>}
          {showManual && <ManualSteps view={view} />}
          {!view.is_default && !view.archived && (
            <div class="domain-danger">
              <span>Archiving stops mail on this domain until you restore it. Mailboxes and messages stay.</span>
              {confirming ? (
                <span class="domain-danger-actions">
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                    Keep
                  </Button>
                  <Button size="sm" variant="danger" loading={busy === "delete"} onClick={() => void archive()}>
                    Archive
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="ghost" icon={<TrashIcon size={13} />} onClick={() => setConfirming(true)}>
                  Archive
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ManualSteps({ view }: { view: DomainView }) {
  return (
    <div class="manual">
      <div class="eyebrow">Do these in the Cloudflare dashboard</div>
      <ol class="manual-steps">
        {view.manual_steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      <CodeBlock title="Verify DNS from a terminal" label="Copy dig commands" code={view.dns_commands} />
    </div>
  );
}

function AddDomainModal({ open, apiConfigured, onClose, onAdded }: { open: boolean; apiConfigured: boolean; onClose: () => void; onAdded: (view: DomainView) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DomainView | null>(null);
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  const valid = DOMAIN_PATTERN.test(domain);
  const close = () => {
    setValue("");
    setError("");
    setResult(null);
    onClose();
  };
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError("");
    try {
      const body = await api<{ domain: DomainView }>("/domains", { method: "POST", body: { domain } });
      onAdded(body.domain);
      setResult(body.domain);
      toast(`Added ${body.domain.domain}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      if (!(caught instanceof ApiError && caught.status < 500)) toastError(caught, "Could not add domain");
    } finally {
      setBusy(false);
    }
  };
  if (result) {
    return (
      <Modal
        open={open}
        onClose={close}
        width={600}
        title={ready(result) ? `${result.domain} is ready` : `Added ${result.domain}`}
        description={
          ready(result)
            ? "Routing, sending, and DNS all check out. New bots can pick this domain now."
            : result.mode === "api"
              ? "BotMail ran the Cloudflare steps it could. DNS can take a few minutes to appear; press Recheck on the Domains page."
              : "Run the steps below in the Cloudflare dashboard, then press Recheck on the Domains page."
        }
        footer={
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        }
      >
        <div class="domain-tiles">
          <StatusTile label="Routing" state={result.routing} detail={tileDetail(result, "routing")} />
          <StatusTile label="Sending" state={result.sending} detail={tileDetail(result, "sending")} />
          <StatusTile label="DNS" state={result.dns} detail={tileDetail(result, "dns")} />
        </div>
        {result.error && (
          <div class="inline-alert" role="alert">
            <AlertIcon size={14} />
            <span>{result.error}</span>
          </div>
        )}
        <CheckList checks={result.checks} />
        {result.mode === "manual" && !ready(result) && <ManualSteps view={result} />}
      </Modal>
    );
  }
  return (
    <Modal
      open={open}
      onClose={close}
      width={500}
      title="Add a mail domain"
      description={
        apiConfigured
          ? "BotMail finds the zone in this Cloudflare account, enables Email Routing, points the catch-all at this Worker, onboards Email Sending, and checks DNS."
          : "Without a CF_API_TOKEN, BotMail records the domain and shows the Cloudflare steps to run yourself."
      }
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()}>
            {apiConfigured ? "Add and provision" : "Add domain"}
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
        <Field
          label="Domain"
          htmlFor="new-domain"
          hint={value && !valid ? <span class="text-red">Enter a hostname like bot.example.com</span> : "A zone in this Cloudflare account, or a subdomain of one. Bots get addresses like name@domain."}
        >
          <Input
            id="new-domain"
            mono
            value={value}
            placeholder="desk.example.com"
            prefix={<GlobeIcon size={14} />}
            onInput={(event) => {
              setValue((event.currentTarget as HTMLInputElement).value);
              setError("");
            }}
            autoComplete="off"
          />
        </Field>
        {error && (
          <div class="inline-alert" role="alert">
            <AlertIcon size={14} />
            <span>{error}</span>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
