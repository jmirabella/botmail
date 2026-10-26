import { useState } from "preact/hooks";
import { api, type HealthView } from "../api";
import { useApp } from "../app";
import { fullTime, relativeTime } from "../format";
import { AlertIcon, BoltIcon, InboxIcon, PaperclipIcon, RefreshIcon, SendIcon, ShieldIcon } from "../icons";
import { toast, toastError } from "../toast";
import { Avatar, Badge, Button, CheckList, EmptyState, ErrorNote, LinkButton, PageHeader, Panel, Skeleton, SkeletonRows, useResource } from "../ui";

export function HealthPage() {
  const { botName, session } = useApp();
  const resource = useResource(() => api<HealthView>("/health"), []);
  const [draining, setDraining] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [retrying, setRetrying] = useState("");
  const data = resource.data;
  const count = (direction: string, status?: string) =>
    (data?.counts ?? []).filter((row) => row.direction === direction && (!status || row.status === status)).reduce((sum, row) => sum + Number(row.n), 0);
  const failures = (data?.deliveries ?? []).filter((row) => row.status === "failed").length;

  const backfill = async () => {
    setBackfilling(true);
    try {
      const body = await api<{ scanned: number; extracted: number; attachments: number }>("/attachments/backfill", { method: "POST", body: {} });
      toast("Stored mail scanned", { detail: `${body.scanned} messages, ${body.attachments} attachments` });
    } catch (error) {
      toastError(error, "Attachment scan failed");
    } finally {
      setBackfilling(false);
    }
  };

  const drain = async () => {
    setDraining(true);
    try {
      const body = await api<{ attempted?: number; delivered?: number }>("/webhooks/drain", { method: "POST", body: {} });
      toast("Webhook queue drained", { detail: body.attempted !== undefined ? `${body.attempted} attempted` : undefined });
      await resource.reload();
    } catch (error) {
      toastError(error, "Drain failed");
    } finally {
      setDraining(false);
    }
  };

  const retry = async (id: string) => {
    setRetrying(id);
    try {
      const body = await api<{ status: string }>(`/webhooks/${encodeURIComponent(id)}/retry`, { method: "POST", body: {} });
      toast(body.status === "success" ? "Delivery succeeded" : "Retry failed", { kind: body.status === "success" ? "success" : "error" });
      await resource.reload();
    } catch (error) {
      toastError(error, "Retry failed");
    } finally {
      setRetrying("");
    }
  };

  return (
    <div class="page">
      <PageHeader
        title="Health"
        subtitle={<>Delivery, DNS, and webhook status. DNS shows the default domain <span class="mono">{session.mail_domain}</span></>}
        actions={
          <>
            <Button variant="ghost" icon={<RefreshIcon size={14} class={resource.loading ? "spin" : undefined} />} onClick={() => void resource.reload()}>
              Refresh
            </Button>
            <Button variant="secondary" icon={<PaperclipIcon size={14} />} loading={backfilling} onClick={() => void backfill()}>
              Extract stored attachments
            </Button>
            <Button variant="secondary" icon={<BoltIcon size={14} />} loading={draining} onClick={() => void drain()}>
              Drain webhook queue
            </Button>
          </>
        }
      />
      {resource.error && <ErrorNote error={resource.error} onRetry={() => void resource.reload()} />}
      <div class="stats">
        <StatCard icon={<InboxIcon size={15} />} label="Received" value={data ? count("in") : undefined} />
        <StatCard icon={<SendIcon size={15} />} label="Sent" value={data ? count("out", "sent") : undefined} />
        <StatCard icon={<ShieldIcon size={15} />} label="Awaiting approval" value={data ? count("out", "pending_approval") : undefined} tone={data && count("out", "pending_approval") > 0 ? "amber" : undefined} />
        <StatCard icon={<AlertIcon size={15} />} label="Webhook failures" value={data ? failures : undefined} tone={failures > 0 ? "red" : undefined} />
      </div>
      <div class="health-grid">
        <Panel title="DNS" eyebrow={data?.dns.domain ?? session.mail_domain}>
          {!data && <SkeletonRows rows={5} avatar={false} />}
          {data && data.dns.error && (
            <div class="inline-alert">
              <AlertIcon size={14} /> {data.dns.error}
            </div>
          )}
          {data && data.dns.checks.length > 0 && <CheckList checks={data.dns.checks} />}
          {(session.domains?.length ?? 0) > 1 && (
            <div class="panel-foot-link">
              <LinkButton href="/domains" variant="ghost" size="sm">
                All domains
              </LinkButton>
            </div>
          )}
        </Panel>
        <Panel title="Webhook deliveries" eyebrow="Latest 40" flush>
          {!data && <SkeletonRows rows={5} />}
          {data && data.deliveries.length === 0 && <EmptyState compact icon={<BoltIcon size={18} />} title="No deliveries yet" body="Wake webhooks appear here after mail arrives for a bot with a webhook." />}
          {data && data.deliveries.length > 0 && (
            <div class="table-scroll">
              <table class="table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Bot</th>
                    <th class="hide-sm num">Attempts</th>
                    <th>Response</th>
                    <th class="hide-md">Updated</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.deliveries.map((row) => (
                    <tr key={row.id}>
                      <td>{row.status === "success" ? <Badge tone="green" dot>Delivered</Badge> : row.status === "failed" ? <Badge tone="red" dot>Failed</Badge> : <Badge tone="amber" dot>Pending</Badge>}</td>
                      <td>
                        <span class="cell-bot cell-bot-sm">
                          <Avatar seed={row.bot_id} label={botName(row.bot_id)} size={20} square />
                          {botName(row.bot_id)}
                        </span>
                      </td>
                      <td class="hide-sm num mono">{row.attempts}</td>
                      <td class="cell-response">
                        {row.last_status_code ? <span class="mono">HTTP {row.last_status_code}</span> : null}
                        {row.last_error && row.last_error !== `HTTP ${row.last_status_code}` && (
                          <span class="cell-error" title={row.last_error}>
                            {row.last_error}
                          </span>
                        )}
                        {!row.last_status_code && !row.last_error && <span class="cell-muted">—</span>}
                      </td>
                      <td class="hide-md">
                        <span class="cell-muted" title={fullTime(row.updated_at)}>
                          {relativeTime(row.updated_at)}
                        </span>
                      </td>
                      <td class="cell-actions">
                        {row.status !== "success" && (
                          <Button size="sm" variant="ghost" loading={retrying === row.id} onClick={() => void retry(row.id)}>
                            Retry
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, tone }: { icon: preact.ComponentChildren; label: string; value: number | undefined; tone?: "red" | "amber" }) {
  return (
    <div class={`stat-card ${tone ? `is-${tone}` : ""}`}>
      <div class="stat-card-head">
        <span class="stat-card-icon">{icon}</span>
        {label}
      </div>
      <div class="stat-card-value">{value === undefined ? <Skeleton width="48px" height={22} /> : value.toLocaleString()}</div>
    </div>
  );
}
