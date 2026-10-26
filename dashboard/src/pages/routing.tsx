import { useEffect, useState } from "preact/hooks";
import { api, type RouteRule, type UnknownPolicy } from "../api";
import { useApp, visibleBots } from "../app";
import { AlertIcon, ChevronRight, InboxIcon, PlusIcon, RouteIcon, SendIcon, ShieldIcon, TrashIcon } from "../icons";
import { toast, toastError } from "../toast";
import { ArchiveToggle, Avatar, Badge, Button, EmptyState, ErrorNote, Input, Modal, NotesHint, PageHeader, Panel, RadioCard, Segmented, Select, SkeletonRows, Switch, useResource } from "../ui";

type RoutesView = { routes: RouteRule[]; unknown_policy: UnknownPolicy; unknown_bot: string };

export function RoutingPage() {
  const { session, bots, botName, botAddress, multiDomain } = useApp();
  const domains = (session.domains ?? []).filter((item) => item.enabled);
  const resource = useResource(() => api<RoutesView>("/routes?include_archived=1"), []);
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState<RouteRule | null>(null);
  const allRoutes = resource.data?.routes ?? [];
  const archivedCount = allRoutes.filter((route) => route.deleted_at).length;
  const routes = showArchived ? allRoutes : allRoutes.filter((route) => !route.deleted_at);
  const [kind, setKind] = useState<"alias" | "forward">("alias");
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState(() => domains.find((item) => item.is_default)?.domain ?? session.mail_domain);
  const [target, setTarget] = useState("");
  const [targets, setTargets] = useState<string[]>([]);
  const [editing, setEditing] = useState<RouteRule | null>(null);
  const [editTargets, setEditTargets] = useState<string[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [adding, setAdding] = useState(false);
  const [policy, setPolicy] = useState<UnknownPolicy>("unrouted");
  const [defaultBot, setDefaultBot] = useState("");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const botChoices = visibleBots(bots);
  const botOptions = botChoices.map((bot) => ({ value: bot.id, label: multiDomain ? `${botName(bot.id)} · ${bot.address}` : botName(bot.id) }));
  const notesFor = (id: string) => bots.find((bot) => bot.id === id)?.notes ?? "";

  useEffect(() => {
    if (!resource.data) return;
    setPolicy(resource.data.unknown_policy);
    setDefaultBot(resource.data.unknown_bot || botChoices[0]?.id || "");
  }, [resource.data]);
  useEffect(() => {
    if (kind === "forward" && botChoices.some((bot) => bot.id === target)) setTarget("");
  }, [kind, bots]);

  const toggleTarget = (id: string) => {
    setTargets((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const add = async () => {
    setAdding(true);
    try {
      const localPart = local.trim().toLowerCase();
      await api("/routes", {
        method: "POST",
        body: kind === "alias" ? { kind, local_part: localPart, domain, targets } : { kind, local_part: localPart, domain, target: target.trim() },
      });
      toast(`Routed ${localPart}@${domain}`);
      setLocal("");
      if (kind === "alias") setTargets([]);
      else setTarget("");
      await resource.reload();
    } catch (error) {
      toastError(error, "Could not add rule");
    } finally {
      setAdding(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSavingEdit(true);
    try {
      await api(`/routes/${encodeURIComponent(editing.id)}`, { method: "PATCH", body: { targets: editTargets } });
      toast("Alias updated");
      setEditing(null);
      await resource.reload();
    } catch (error) {
      toastError(error, "Could not update alias");
    } finally {
      setSavingEdit(false);
    }
  };

  const toggle = async (route: RouteRule, enabled: boolean) => {
    resource.mutate((view) => ({ ...view!, routes: view!.routes.map((item) => (item.id === route.id ? { ...item, enabled: enabled ? 1 : 0 } : item)) }));
    try {
      await api(`/routes/${encodeURIComponent(route.id)}`, { method: "PATCH", body: { enabled } });
      toast(enabled ? "Rule enabled" : "Rule paused");
    } catch (error) {
      toastError(error, "Could not update rule");
      await resource.reload();
    }
  };

  const remove = async (route: RouteRule) => {
    try {
      await api(`/routes/${encodeURIComponent(route.id)}`, { method: "DELETE" });
      toast("Rule archived", { detail: `${route.local_part}@${route.domain} can be restored. The address stays reserved.` });
      setArchiving(null);
      await resource.reload();
    } catch (error) {
      toastError(error, "Could not archive rule");
    }
  };
  const restore = async (route: RouteRule) => {
    try {
      await api(`/routes/${encodeURIComponent(route.id)}/restore`, { method: "POST", body: {} });
      toast("Rule restored", { detail: `${route.local_part}@${route.domain}` });
      await resource.reload();
    } catch (error) {
      toastError(error, "Could not restore rule");
    }
  };

  const savePolicy = async () => {
    setSavingPolicy(true);
    try {
      await api("/routes/unknown", { method: "PUT", body: { unknown_policy: policy, unknown_bot: policy === "default_bot" ? defaultBot : "" } });
      toast("Unknown-recipient policy saved");
      await resource.reload();
    } catch (error) {
      toastError(error, "Could not save policy");
    } finally {
      setSavingPolicy(false);
    }
  };

  const policyDirty = resource.data && (policy !== resource.data.unknown_policy || (policy === "default_bot" && defaultBot !== resource.data.unknown_bot));
  const localOk = /^[a-z0-9][a-z0-9._-]{0,62}$/i.test(local.trim());
  const canAdd = localOk && (kind === "alias" ? targets.length > 0 : target.trim().length > 0);
  const routeTargets = (route: RouteRule) => (route.targets && route.targets.length > 0 ? route.targets : route.target ? [route.target] : []);

  return (
    <div class="page">
      <PageHeader
        title="Routing"
        subtitle={
          <span class="precedence">
            <span>Bot address</span>
            <ChevronRight size={11} />
            <span>Alias</span>
            <ChevronRight size={11} />
            <span>Forward</span>
            <ChevronRight size={11} />
            <span>Unknown policy</span>
          </span>
        }
      />
      <div class="stack">
        <Panel
          title="Address rules"
          eyebrow={multiDomain ? `${domains.length} domains` : `*@${domain}`}
          flush
          actions={<ArchiveToggle pressed={showArchived} count={archivedCount} onToggle={() => setShowArchived((value) => !value)} />}
        >
          <form
            class="rule-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (canAdd) void add();
            }}
          >
            <Input mono class="rule-local" value={local} placeholder="support" suffix={multiDomain ? undefined : `@${domain}`} aria-label="Local part" onInput={(event) => setLocal((event.currentTarget as HTMLInputElement).value)} />
            {multiDomain && <Select class="rule-domain" label="Domain" value={domain} onChange={setDomain} options={domains.map((item) => ({ value: item.domain, label: `@${item.domain}` }))} />}
            <Segmented
              label="Rule type"
              value={kind}
              onChange={setKind}
              options={[
                { value: "alias", label: "Alias to bot" },
                { value: "forward", label: "Forward" },
              ]}
            />
            {kind === "alias" ? (
              <BotChecks class="rule-targets" label="Deliver a copy to each selected mailbox" options={botOptions} selected={targets} onToggle={toggleTarget} />
            ) : (
              <Input mono class="rule-target" type="email" value={target} placeholder="ops@example.com" aria-label="Forward to" onInput={(event) => setTarget((event.currentTarget as HTMLInputElement).value)} />
            )}
            <Button type="submit" variant="primary" icon={<PlusIcon size={14} stroke={2} />} loading={adding} disabled={!canAdd}>
              Add rule
            </Button>
          </form>
          {resource.error && <ErrorNote error={resource.error} onRetry={() => void resource.reload()} />}
          {resource.loading && !resource.data && <SkeletonRows rows={3} avatar={false} />}
          {resource.data && routes.length === 0 && (
            <EmptyState compact icon={<RouteIcon size={18} />} title="No custom rules" body="Bot addresses route themselves. An alias delivers one address into one or more mailboxes. A forward sends an address outside BotMail." />
          )}
          {routes.length > 0 && (
            <div class="table-scroll">
              <table class="table">
                <thead>
                  <tr>
                    <th>Address</th>
                    <th class="hide-sm">Type</th>
                    <th>Delivers to</th>
                    <th>Enabled</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {routes.map((route) => (
                    <tr key={route.id} class={route.enabled && !route.deleted_at ? "" : "is-muted"}>
                      <td>
                        <span class="mono addr">
                          {route.local_part}
                          <span class="addr-domain">@{route.domain}</span>
                        </span>
                      </td>
                      <td class="hide-sm">
                        {route.deleted_at ? <Badge tone="amber">Archived</Badge> : route.kind === "alias" ? <Badge tone="accent">Alias</Badge> : <Badge tone="blue">Forward</Badge>}
                      </td>
                      <td>
                        {route.kind === "alias" ? (
                          <span class="alias-targets">
                            {routeTargets(route).map((id) => (
                              <span class="cell-bot cell-bot-sm" key={id}>
                                <Avatar seed={id} label={botName(id)} size={20} square />
                                <span title={botAddress(id)}>{botName(id)}</span>
                                <NotesHint notes={notesFor(id)} label={botAddress(id)} />
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span class="cell-forward mono">
                            <SendIcon size={12} /> {route.target}
                          </span>
                        )}
                      </td>
                      <td>
                        <Switch checked={route.enabled === 1 && !route.deleted_at} label={`Enable ${route.local_part}`} disabled={Boolean(route.deleted_at)} onChange={(next) => void toggle(route, next)} />
                      </td>
                      <td class="cell-actions">
                        {route.deleted_at ? (
                          <Button size="sm" variant="secondary" onClick={() => void restore(route)}>
                            Restore
                          </Button>
                        ) : (
                          <span class="row-actions">
                            {route.kind === "alias" && (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  setEditing(route);
                                  setEditTargets(routeTargets(route));
                                }}
                              >
                                Edit
                              </Button>
                            )}
                            <button class="icon-btn icon-btn-danger" aria-label={`Archive ${route.local_part}`} title="Archive rule" onClick={() => setArchiving(route)}>
                              <TrashIcon size={14} />
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Modal
          open={Boolean(archiving)}
          onClose={() => setArchiving(null)}
          title={archiving ? `Archive ${archiving.local_part}@${archiving.domain}?` : "Archive rule"}
          description="The rule stops matching immediately and can be restored. The address stays reserved. Mail already delivered is kept."
          footer={
            <>
              <Button variant="ghost" onClick={() => setArchiving(null)}>
                Keep
              </Button>
              <Button variant="danger" onClick={() => archiving && void remove(archiving)}>
                Archive
              </Button>
            </>
          }
        />
        <Modal
          open={Boolean(editing)}
          onClose={() => setEditing(null)}
          title={editing ? `Edit ${editing.local_part}@${editing.domain}` : "Edit alias"}
          description="Each selected mailbox gets its own copy. Removing a mailbox here stops future copies to it and does not delete mail."
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={savingEdit} disabled={editTargets.length === 0} onClick={() => void saveEdit()}>
                Save alias
              </Button>
            </>
          }
        >
          <BotChecks label="Mailboxes" options={botOptions} selected={editTargets} onToggle={(id) => setEditTargets((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))} />
        </Modal>
        <Panel
          title="Unknown recipients"
          eyebrow="Fallback"
          actions={
            <Button variant="primary" size="sm" loading={savingPolicy} disabled={!policyDirty} onClick={() => void savePolicy()}>
              Save policy
            </Button>
          }
        >
          <div class="radio-grid" role="radiogroup" aria-label="Unknown recipient policy">
            <RadioCard checked={policy === "unrouted"} onSelect={() => setPolicy("unrouted")} icon={<InboxIcon size={14} />} title="Hold in Unrouted" body="Keep the message in the Unrouted mailbox for review. Nothing bounces." />
            <RadioCard checked={policy === "reject"} onSelect={() => setPolicy("reject")} icon={<ShieldIcon size={14} />} title="Reject at SMTP" body="Refuse mail for addresses that match no bot or rule. Senders get a bounce." />
            <RadioCard checked={policy === "default_bot"} onSelect={() => setPolicy("default_bot")} icon={<AlertIcon size={14} />} title="Deliver to a default bot" body="Send everything else to one catch-all bot.">
              {policy === "default_bot" && (
                <div class="radio-card-extra" onClick={(event) => event.stopPropagation()}>
                  <Select label="Default bot" value={defaultBot} onChange={setDefaultBot} options={botOptions} />
                </div>
              )}
            </RadioCard>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function BotChecks({
  options,
  selected,
  onToggle,
  label,
  class: className,
}: {
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  label: string;
  class?: string;
}) {
  return (
    <div class={className ? `check-list ${className}` : "check-list"} role="group" aria-label={label}>
      {options.length === 0 && <span class="field-hint">No mailboxes yet.</span>}
      {options.map((option) => (
        <label class="check-row" key={option.value}>
          <input type="checkbox" checked={selected.includes(option.value)} onChange={() => onToggle(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
