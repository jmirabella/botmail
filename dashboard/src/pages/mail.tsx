import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, type MailDetail, type MailList, type MailSummary } from "../api";
import { mailboxBots, useApp, visibleBots } from "../app";
import { bytes, fullTime, hueFor, parseAddress, plural, relativeTime, shortTime } from "../format";
import { AlertIcon, ArrowLeft, CheckIcon, CodeIcon, DownloadIcon, InboxIcon, MailIcon, MailOpenIcon, PaperclipIcon, RefreshIcon, SearchIcon, SendIcon, ShieldIcon, XIcon } from "../icons";
import { linkHandler, navigate, useLocation, withQuery } from "../router";
import { toast, toastError } from "../toast";
import { Avatar, Badge, Button, CopyButton, cx, EmptyState, ErrorNote, Kbd, Modal, Segmented, Select, Skeleton, SkeletonRows, useHotkeys, useResource } from "../ui";

type View = "in" | "junk" | "quarantine" | "out" | "all";

export function MailPage({ id }: { id?: string }) {
  const { session, bots, botName, botAddress, reloadBots } = useApp();
  const { query } = useLocation();
  const bot = query.get("bot") ?? "";
  const view = (["in", "junk", "quarantine", "out", "all"].includes(query.get("view") ?? "") ? query.get("view") : "in") as View;
  const unreadOnly = query.get("unread") === "1";
  const [search, setSearch] = useState(query.get("q") ?? "");
  const [debounced, setDebounced] = useState(search);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 220);
    return () => clearTimeout(timer);
  }, [search]);

  const state = { bot: bot || undefined, view: view === "in" ? undefined : view, unread: unreadOnly ? "1" : undefined, q: debounced || undefined };
  const hrefFor = (messageId?: string) => withQuery(messageId ? `/mail/${encodeURIComponent(messageId)}` : "/mail", state);

  useEffect(() => {
    const next = hrefFor(id);
    if (next !== location.pathname + location.search) navigate(next, { replace: true });
  }, [debounced]);

  const list = useInbox(bot, view, debounced, unreadOnly, listRef);

  const drafts = useResource(
    async () => (session.send_policy === "approval" ? (await api<{ drafts: MailSummary[] }>("/drafts")).drafts : []),
    [session.send_policy],
  );

  const messages = useMemo(() => (list.data ?? []).filter((row) => !unreadOnly || !row.is_read), [list.data, unreadOnly]);
  const selectedIndex = messages.findIndex((row) => row.id === id);

  const setRead = async (messageId: string, isRead: boolean, quiet = false) => {
    list.mutate((rows) => (rows ?? []).map((row) => (row.id === messageId ? { ...row, is_read: isRead } : row)));
    try {
      await api(`/mail/${encodeURIComponent(messageId)}`, { method: "PATCH", body: { is_read: isRead } });
      if (!quiet) toast(isRead ? "Marked as read" : "Marked as unread");
      void reloadBots();
    } catch (error) {
      toastError(error, "Could not update message");
    }
  };

  const open = (messageId: string) => navigate(hrefFor(messageId));

  useEffect(() => {
    if (!id) return;
    const row = list.data?.find((item) => item.id === id);
    if (row && !row.is_read && row.direction === "in") void setRead(id, true, true);
    listRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [id, list.data !== undefined]);

  useEffect(() => {
    const node = sentinelRef.current;
    const root = listRef.current;
    if (!node || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void list.loadMore();
      },
      { root, rootMargin: "160px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [list.nextCursor, list.loadMore]);

  useHotkeys(
    (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        const next = messages[selectedIndex + 1];
        if (next) open(next.id);
        else if (list.nextCursor) void list.loadMore();
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = messages[Math.max(selectedIndex - 1, 0)];
        if (next) open(next.id);
      } else if (event.key === "Escape" && id) {
        navigate(hrefFor());
      } else if (event.key === "u" && id) {
        const row = messages[selectedIndex];
        if (row) void setRead(row.id, !row.is_read);
      } else if (event.key === "r") {
        void list.reload();
      }
    },
    [messages, selectedIndex, id, bot, view, unreadOnly, debounced, list.nextCursor, list.loadMore],
  );

  const botOptions = [
    { value: "", label: "All mailboxes" },
    ...mailboxBots(bots).map((item) => ({ value: item.id, label: botName(item.id) })),
    { value: "_unrouted", label: "Unrouted" },
  ];
  const setFilter = (next: Partial<{ bot: string; view: View; unread: boolean }>) => {
    const merged = {
      bot: (next.bot ?? bot) || undefined,
      view: (next.view ?? view) === "in" ? undefined : next.view ?? view,
      unread: (next.unread ?? unreadOnly) ? "1" : undefined,
      q: debounced || undefined,
    };
    navigate(withQuery("/mail", merged));
  };
  const pendingCount = drafts.data?.length ?? 0;
  const scopeLabel = bot ? botName(bot) : "All mailboxes";

  return (
    <div class={cx("mail", id && "has-selection")}>
      <section class="mail-list" aria-label="Messages">
        <header class="mail-list-head">
          <div class="mail-list-title">
            <div>
              <h1 class="page-title">{scopeLabel}</h1>
              <div class="page-subtitle mono">{bot && bot !== "_unrouted" ? botAddress(bot) : bot === "_unrouted" ? "No matching bot or rule" : `${plural(visibleBots(bots).length, "mailbox")}`}</div>
            </div>
            <button class="icon-btn" aria-label="Refresh" title="Refresh (R)" onClick={() => void list.reload()}>
              <RefreshIcon size={15} class={list.loading ? "spin" : undefined} />
            </button>
          </div>
          <div class="mail-search-row">
            <div class="search">
              <SearchIcon size={14} />
              <input
                ref={searchRef}
                value={search}
                placeholder="Search subject, sender, body"
                aria-label="Search mail"
                onInput={(event) => setSearch((event.currentTarget as HTMLInputElement).value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearch("");
                    (event.currentTarget as HTMLInputElement).blur();
                  }
                }}
              />
              {search ? (
                <button class="search-clear" aria-label="Clear search" onClick={() => setSearch("")}>
                  <XIcon size={12} />
                </button>
              ) : (
                <Kbd>/</Kbd>
              )}
            </div>
            <Select class="mail-bot-select" label="Mailbox" value={bot} onChange={(next) => setFilter({ bot: next })} options={botOptions} />
          </div>
          <div class="mail-filters">
            <Segmented<View>
              label="Direction"
              size="sm"
              value={view}
              onChange={(next) => setFilter({ view: next })}
              options={[
                { value: "in", label: "Inbox" },
                { value: "junk", label: "Junk" },
                { value: "quarantine", label: "Quarantine" },
                { value: "out", label: "Sent" },
                { value: "all", label: "All" },
              ]}
            />
            <button class={cx("chip", unreadOnly && "is-active")} aria-pressed={unreadOnly} onClick={() => setFilter({ unread: !unreadOnly })}>
              <span class="unread-dot" /> Unread
            </button>
          </div>
        </header>
        {pendingCount > 0 && (
          <button class="approval-banner" onClick={() => setReviewOpen(true)}>
            <span class="approval-icon">
              <ShieldIcon size={15} />
            </span>
            <span class="approval-text">
              <strong>{plural(pendingCount, "draft")} awaiting approval</strong>
              <span>Outbound mail held by the approval policy</span>
            </span>
            <span class="approval-cta">Review</span>
          </button>
        )}
        <div class="mail-items" ref={listRef} role="listbox" aria-label="Message list" aria-busy={list.loading || list.loadingMore}>
          {list.loading && !list.data && <SkeletonRows rows={9} />}
          {list.error && <ErrorNote error={list.error} onRetry={() => void list.reload()} />}
          {list.data && messages.length === 0 && !list.nextCursor && !list.loadingMore && (
            <EmptyState
              compact
              icon={debounced ? <SearchIcon size={18} /> : <InboxIcon size={18} />}
              title={debounced ? "No matches" : unreadOnly ? "All caught up" : view === "out" ? "Nothing sent yet" : view === "quarantine" ? "Quarantine is empty" : view === "junk" ? "Junk is empty" : "No mail yet"}
              body={
                debounced ? (
                  <>Nothing matches “{debounced}”.</>
                ) : bot && bot !== "_unrouted" ? (
                  <span class="empty-address">
                    Send a message to <span class="mono addr">{botAddress(bot)}</span>
                    <CopyButton value={botAddress(bot)} label="Copy address" />
                  </span>
                ) : (
                  "Mail delivered to any bot address lands here."
                )
              }
            />
          )}
          {messages.map((row) => (
            <MailRow key={row.id} row={row} selected={row.id === id} botLabel={botName(row.bot)} href={hrefFor(row.id)} />
          ))}
          {list.loadingMore && (
            <div class="mail-more" role="status">
              <span class="spinner" aria-hidden="true" />
              Loading
            </div>
          )}
          {list.moreError && <ErrorNote error={list.moreError} onRetry={() => void list.loadMore()} />}
          {!list.loading && !list.loadingMore && !list.error && !list.moreError && messages.length > 0 && !list.nextCursor && (
            <div class="mail-end">End of list</div>
          )}
          {list.nextCursor && !list.moreError && <div ref={sentinelRef} class="mail-sentinel" aria-hidden="true" />}
        </div>
        <footer class="mail-list-foot">
          <span>{list.data ? plural(messages.length, "message") : "Loading"}</span>
          <span class="mail-keys">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd> move <Kbd>u</Kbd> unread <Kbd>esc</Kbd> close
          </span>
        </footer>
      </section>
      <section class="reader" aria-label="Reading pane">
        {id ? (
          <Reader key={id} id={id} backHref={hrefFor()} onRead={(isRead) => void setRead(id, isRead)} onChanged={() => void list.reload()} />
        ) : (
          <div class="reader-empty">
            <EmptyState
              icon={<MailOpenIcon size={20} />}
              title="Select a message"
              body={
                <>
                  Pick a message from the list, or use <Kbd>j</Kbd> and <Kbd>k</Kbd> to move through mail.
                </>
              }
            />
          </div>
        )}
      </section>
      <ApprovalModal
        open={reviewOpen}
        drafts={drafts.data ?? []}
        onClose={() => setReviewOpen(false)}
        onDecided={() => {
          void drafts.reload();
          void list.reload();
        }}
      />
    </div>
  );
}

function inboxPath(bot: string, view: View, q: string, unread: boolean, cursor: string | null): string {
  const params = new URLSearchParams();
  if (bot) params.set("bot", bot);
  if (view === "quarantine") params.set("folder", "quarantine");
  else if (view === "junk") params.set("folder", "junk");
  else if (view !== "all") params.set("direction", view);
  if (q) params.set("q", q);
  if (unread) params.set("unread", "1");
  if (cursor) params.set("cursor", cursor);
  const text = params.toString();
  return text ? `/mail?${text}` : "/mail";
}

function uniqueMessages(rows: MailSummary[]): MailSummary[] {
  const seen = new Set<string>();
  const out: MailSummary[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function appendMessages(current: MailSummary[], incoming: MailSummary[]): MailSummary[] {
  const seen = new Set(current.map((row) => row.id));
  const extra = incoming.filter((row) => !seen.has(row.id));
  return extra.length === 0 ? current : [...current, ...extra];
}

function useInbox(bot: string, view: View, q: string, unread: boolean, listRef: { current: HTMLDivElement | null }) {
  const [data, setData] = useState<MailSummary[] | undefined>(undefined);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [moreError, setMoreError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);

  const loadFirst = useCallback(
    async (clear: boolean) => {
      const mine = ++generation.current;
      cursorRef.current = null;
      loadingMoreRef.current = false;
      setNextCursor(null);
      setLoadingMore(false);
      setMoreError(undefined);
      setLoading(true);
      if (clear) {
        setData(undefined);
        setError(undefined);
      }
      listRef.current?.scrollTo({ top: 0 });
      try {
        const page = await api<MailList>(inboxPath(bot, view, q, unread, null));
        if (mine !== generation.current) return;
        setData(uniqueMessages(page.messages));
        cursorRef.current = page.next_cursor;
        setNextCursor(page.next_cursor);
        setError(undefined);
      } catch (caught) {
        if (mine !== generation.current) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [bot, view, q, unread],
  );

  useEffect(() => {
    void loadFirst(true);
  }, [loadFirst]);

  const reload = useCallback(() => loadFirst(false), [loadFirst]);

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor || loadingMoreRef.current) return;
    const mine = generation.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await api<MailList>(inboxPath(bot, view, q, unread, cursor));
      if (mine !== generation.current) return;
      setData((current) => appendMessages(current ?? [], page.messages));
      cursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (caught) {
      if (mine !== generation.current) return;
      setMoreError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (mine !== generation.current) return;
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [bot, view, q, unread]);

  const mutate = useCallback((next: MailSummary[] | ((current: MailSummary[] | undefined) => MailSummary[])) => {
    setData((current) => (typeof next === "function" ? next(current) : next));
  }, []);

  return { data, error, moreError, loading, loadingMore, nextCursor, reload, loadMore, mutate };
}

function MailRow({ row, selected, botLabel, href }: { row: MailSummary; selected: boolean; botLabel: string; href: string }) {
  const outbound = row.direction === "out";
  const counterpart = outbound ? parseAddress(row.to[0]) : parseAddress(row.from);
  const unread = !row.is_read && !outbound;
  const name = counterpart.name || counterpart.email || "Unknown sender";
  return (
    <a
      href={href}
      onClick={linkHandler(href)}
      data-id={row.id}
      role="option"
      aria-selected={selected}
      class={cx("mail-row", selected && "is-selected", unread && "is-unread")}
    >
      <span class="mail-row-dot" aria-label={unread ? "Unread" : undefined} />
      <Avatar seed={row.bot} label={botLabel} size={30} square />
      <span class="mail-row-main">
        <span class="mail-row-top">
          <span class="mail-row-from">
            {outbound && <span class="mail-row-to">To</span>}
            {name}
          </span>
          <span class="mail-row-time" title={fullTime(row.date)}>
            {shortTime(row.date)}
          </span>
        </span>
        <span class="mail-row-subject">{row.subject || "(no subject)"}</span>
        <span class="mail-row-snippet">{row.snippet || " "}</span>
        <span class="mail-row-meta">
          <span class="bot-chip" style={{ "--h": String(hueFor(row.bot)) }}>
            {botLabel}
          </span>
          {row.has_attachments && (
            <span class="meta-icon" title="Has attachments">
              <PaperclipIcon size={12} />
            </span>
          )}
          {row.quarantine_reason && <Badge tone="red">{row.quarantine_reason}</Badge>}
          {typeof row.spam_score === "number" && <Badge tone="neutral">Spam {row.spam_score}</Badge>}
          {row.auth_passed === false && <Badge tone="amber">Auth fail</Badge>}
          {row.auth_result === "internal" && <Badge tone="green">Internal</Badge>}
          {row.auth_result === "unverified" && row.direction === "in" && <Badge tone="neutral">Unverified</Badge>}
          {row.auth_result === "pass" && row.direction === "in" && row.folder !== "quarantine" && !row.quarantine_reason && (
            <Badge tone="neutral">Auth pass</Badge>
          )}
          {row.status === "pending_approval" && <Badge tone="amber">Pending</Badge>}
          {row.status === "rejected" && <Badge tone="red">Rejected</Badge>}
          {row.status === "failed" && <Badge tone="red">Failed</Badge>}
          {row.via_alias && <span class="tag mono">via {row.via_alias}</span>}
          {row.plus_tag && <span class="tag mono">+{row.plus_tag}</span>}
        </span>
      </span>
    </a>
  );
}

function Reader({ id, backHref, onRead, onChanged }: { id: string; backHref: string; onRead: (isRead: boolean) => void; onChanged: () => void }) {
  const { botName, botAddress: addressOf } = useApp();
  const detail = useResource(async () => (await api<{ message: MailDetail }>(`/mail/${encodeURIComponent(id)}`)).message, [id]);
  const [tab, setTab] = useState<"text" | "html" | "headers">("text");
  const [acting, setActing] = useState("");
  const message = detail.data;
  useEffect(() => {
    if (message) setTab(message.text?.trim() ? "text" : message.html ? "html" : "text");
  }, [message?.id]);

  if (detail.error) {
    return (
      <div class="reader-empty">
        <EmptyState
          icon={<AlertIcon size={18} />}
          title="Message unavailable"
          body={detail.error.message}
          action={
            <Button variant="secondary" onClick={() => navigate(backHref)}>
              Back to list
            </Button>
          }
        />
      </div>
    );
  }
  if (!message) return <ReaderSkeleton />;

  const from = parseAddress(message.from);
  const outbound = message.direction === "out";
  const botAddress = addressOf(message.bot);
  return (
    <article class="reader-inner">
      <div class="reader-toolbar">
        <a class="icon-btn reader-back" href={backHref} onClick={linkHandler(backHref)} aria-label="Back to list">
          <ArrowLeft size={16} />
        </a>
        <span class="bot-chip bot-chip-lg" style={{ "--h": String(hueFor(message.bot)) }}>
          {outbound ? <SendIcon size={12} /> : <InboxIcon size={12} />}
          {botName(message.bot)}
        </span>
        <span class="reader-toolbar-spacer" />
        {message.folder === "junk" && (
          <Button
            size="sm"
            variant="primary"
            loading={acting === "not-junk"}
            onClick={() => {
              setActing("not-junk");
              void api(`/mail/${encodeURIComponent(message.id)}/not-junk`, { method: "POST", body: {} })
                .then(() => {
                  toast("Moved to the inbox");
                  onChanged();
                  return detail.reload();
                })
                .catch((error) => toastError(error, "Could not move message"))
                .finally(() => setActing(""));
            }}
          >
            Not junk
          </Button>
        )}
        {message.folder === "quarantine" && (
          <>
            <Button
              size="sm"
              variant="primary"
              loading={acting === "release"}
              onClick={() => {
                setActing("release");
                void api(`/mail/${encodeURIComponent(message.id)}/release`, { method: "POST", body: {} })
                  .then(() => {
                    toast("Released to the inbox");
                    onChanged();
                    return detail.reload();
                  })
                  .catch((error) => toastError(error, "Could not release"))
                  .finally(() => setActing(""));
              }}
            >
              Release
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={acting === "block"}
              onClick={() => {
                setActing("block");
                void api(`/mail/${encodeURIComponent(message.id)}/block-sender`, { method: "POST", body: {} })
                  .then(() => {
                    toast("Sender blocked. This message stays in quarantine.");
                    onChanged();
                  })
                  .catch((error) => toastError(error, "Could not block sender"))
                  .finally(() => setActing(""));
              }}
            >
              Block sender
            </Button>
          </>
        )}
        {!outbound && (
          <Button size="sm" variant="ghost" icon={<MailIcon size={14} />} onClick={() => onRead(!message.is_read)}>
            Mark unread
          </Button>
        )}
        <a class="btn btn-ghost btn-sm" href={`/admin/api/mail/${encodeURIComponent(message.id)}/raw`} download>
          <DownloadIcon size={14} />
          <span>.eml</span>
        </a>
      </div>
      <header class="reader-head">
        <h2 class="reader-subject">{message.subject || "(no subject)"}</h2>
        <div class="reader-tags">
          {message.quarantine_reason && <Badge tone="red" dot>{message.quarantine_reason}</Badge>}
          {typeof message.spam_score === "number" && <Badge tone="neutral" dot>Spam {message.spam_score}</Badge>}
          {message.auth_result === "internal" && <Badge tone="green" dot>Internal</Badge>}
          {message.auth_result === "pass" && message.folder !== "quarantine" && !message.quarantine_reason && (
            <Badge tone="neutral" dot>Auth pass</Badge>
          )}
          {message.auth_result === "unverified" && message.direction === "in" && <Badge tone="neutral" dot>Unverified</Badge>}
          {message.auth_passed === false && <Badge tone="amber" dot>Auth fail</Badge>}
          {message.status === "pending_approval" && <Badge tone="amber" dot>Pending approval</Badge>}
          {message.status === "sent" && <Badge tone="green" dot>Sent</Badge>}
          {message.status === "rejected" && <Badge tone="red" dot>Rejected</Badge>}
          {message.status === "failed" && <Badge tone="red" dot>Failed</Badge>}
          {message.via_alias && <span class="tag mono">via {message.via_alias}</span>}
          {message.plus_tag && <span class="tag mono">+{message.plus_tag}</span>}
          {message.body_truncated && <Badge tone="neutral">Body truncated</Badge>}
        </div>
        <div class="reader-from">
          <Avatar seed={from.email || "unknown"} label={from.name || from.email} size={36} />
          <div class="reader-from-text">
            <div class="reader-from-line">
              <span class="reader-from-name">{from.name || from.email || "Unknown sender"}</span>
              {from.email && from.email !== from.name && <span class="reader-from-email mono">{from.email}</span>}
            </div>
            <div class="reader-to">
              to <span class="mono">{message.to.join(", ") || botAddress}</span>
              {message.cc.length > 0 && (
                <>
                  {" "}
                  · cc <span class="mono">{message.cc.join(", ")}</span>
                </>
              )}
            </div>
          </div>
          <div class="reader-date" title={fullTime(message.date)}>
            <div>{fullTime(message.date)}</div>
            <div class="reader-date-rel">{relativeTime(message.date)}</div>
          </div>
        </div>
      </header>
      <div class="reader-tabs">
        <Segmented
          label="Body format"
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: "text", label: "Text" },
            { value: "html", label: "HTML" },
            { value: "headers", label: "Headers" },
          ]}
        />
      </div>
      <div class="reader-body">
        {tab === "text" && (message.text?.trim() ? <div class="reader-text">{message.text}</div> : <div class="reader-muted">This message has no plain text part.</div>)}
        {tab === "html" && (message.html ? <HtmlBody html={message.html} /> : <div class="reader-muted">This message has no HTML part.</div>)}
        {tab === "headers" && <Headers headers={message.headers} />}
      </div>
      {message.attachments.length > 0 && (
        <footer class="reader-attachments">
          <div class="eyebrow">
            {plural(message.attachments.length, "attachment")}
          </div>
          <div class="attachment-list">
            {message.attachments.map((item) => {
              const href = `/admin/api/mail/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(item.id)}`;
              const type = (item.content_type || "").split(";")[0]?.trim().toLowerCase() ?? "";
              const preview = type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp";
              return (
                <div key={item.id} class="attachment-card">
                  {preview && <img class="attachment-preview" src={href} alt={item.filename || "attachment"} />}
                  <a class="attachment" href={href} download={item.filename || "attachment"}>
                    <span class="attachment-icon">
                      <PaperclipIcon size={14} />
                    </span>
                    <span class="attachment-text">
                      <span class="attachment-name">{item.filename || "attachment"}</span>
                      <span class="attachment-meta mono">
                        {item.content_type || "file"} · {bytes(item.size_bytes)}
                        {item.inline ? " · inline" : ""}
                      </span>
                    </span>
                    <DownloadIcon size={14} />
                  </a>
                </div>
              );
            })}
          </div>
        </footer>
      )}
    </article>
  );
}

function HtmlBody({ html }: { html: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{margin:0;padding:20px;font:14px/1.6 -apple-system,Segoe UI,Inter,sans-serif;color:#1d1d22;background:#fff;word-break:break-word}img{max-width:100%;height:auto}a{color:#2f5bd8}</style></head><body>${html}</body></html>`;
  return (
    <div class="html-frame">
      <div class="html-frame-note">
        <CodeIcon size={12} /> Sanitized HTML · remote images blocked
      </div>
      <iframe title="HTML body" sandbox="" srcDoc={doc} />
    </div>
  );
}

function Headers({ headers }: { headers: Record<string, unknown> }) {
  const rows = Object.entries(headers).filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0));
  return (
    <dl class="headers">
      {rows.map(([key, value]) => (
        <div class="headers-row" key={key}>
          <dt class="mono">{key.replaceAll("_", "-")}</dt>
          <dd class="mono">{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReaderSkeleton() {
  return (
    <div class="reader-inner" aria-busy="true">
      <div class="reader-toolbar">
        <Skeleton width="90px" height={22} radius={6} />
      </div>
      <div class="reader-head">
        <Skeleton width="60%" height={20} />
        <div class="reader-from" style={{ marginTop: "18px" }}>
          <Skeleton width="36px" height={36} radius={18} />
          <div class="skeleton-lines" style={{ flex: 1 }}>
            <Skeleton width="40%" height={12} />
            <Skeleton width="55%" height={10} />
          </div>
        </div>
      </div>
      <div class="reader-body">
        <div class="skeleton-lines">
          {[92, 88, 95, 70, 84, 60].map((width, index) => (
            <Skeleton key={index} width={`${width}%`} height={11} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ApprovalModal({ open, drafts, onClose, onDecided }: { open: boolean; drafts: MailSummary[]; onClose: () => void; onDecided: () => void }) {
  const { botName } = useApp();
  const [busy, setBusy] = useState("");
  const decide = async (draft: MailSummary, decision: "approve" | "reject") => {
    setBusy(`${draft.id}:${decision}`);
    try {
      await api(`/drafts/${encodeURIComponent(draft.id)}/${decision}`, { method: "POST", body: {} });
      toast(decision === "approve" ? "Draft approved and sent" : "Draft rejected", { detail: draft.subject || undefined });
      onDecided();
    } catch (error) {
      toastError(error, decision === "approve" ? "Approve failed" : "Reject failed");
    } finally {
      setBusy("");
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Approval queue" description="Recipients outside the mail domain and allowlist wait here until someone approves them." width={620}>
      {drafts.length === 0 ? (
        <EmptyState compact icon={<CheckIcon size={18} />} title="Queue is clear" body="No outbound drafts are waiting." />
      ) : (
        <div class="draft-list">
          {drafts.map((draft) => (
            <div class="draft" key={draft.id}>
              <Avatar seed={draft.bot} label={botName(draft.bot)} size={30} square />
              <div class="draft-main">
                <div class="draft-top">
                  <span class="draft-subject">{draft.subject || "(no subject)"}</span>
                  <span class="draft-time">{shortTime(draft.date)}</span>
                </div>
                <div class="draft-to mono">
                  {botName(draft.bot)} → {draft.to.join(", ")}
                </div>
                {draft.snippet && <div class="draft-snippet">{draft.snippet}</div>}
              </div>
              <div class="draft-actions">
                <Button size="sm" variant="ghost" loading={busy === `${draft.id}:reject`} onClick={() => void decide(draft, "reject")}>
                  Reject
                </Button>
                <Button size="sm" variant="primary" loading={busy === `${draft.id}:approve`} onClick={() => void decide(draft, "approve")}>
                  Approve
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
