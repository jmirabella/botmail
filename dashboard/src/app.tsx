import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, onAccessLost, type Bot, type Session } from "./api";
import { BotIcon, ChevronRight, CommandIcon, GearIcon, GlobeIcon, InboxIcon, LockIcon, LogoutIcon, MenuIcon, PulseIcon, RouteIcon, SearchIcon, ShieldIcon, XIcon } from "./icons";
import { BotDetailPage } from "./pages/bot-detail";
import { BotsPage } from "./pages/bots";
import { DomainsPage } from "./pages/domains";
import { HealthPage } from "./pages/health";
import { MailPage } from "./pages/mail";
import { RoutingPage } from "./pages/routing";
import { SettingsPage } from "./pages/settings";
import { linkHandler, matchRoute, navigate, useLocation, type Route } from "./router";
import { Toaster } from "./toast";
import { domainTag } from "./format";
import { Avatar, Button, cx, EmptyState, Kbd, NotesHint, Skeleton, useHotkeys, useResource } from "./ui";

type AppState = {
  session: Session;
  setSession: (next: Session) => void;
  bots: Bot[];
  botsLoading: boolean;
  reloadBots: () => Promise<void>;
  /** Display name, with a domain tag when another mailbox shares the name or local part. */
  botName: (id: string) => string;
  botAddress: (id: string) => string;
  /** More than one mail domain exists, so addresses must always show their domain. */
  multiDomain: boolean;
};

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error("App context missing");
  return value;
}

export function visibleBots(bots: Bot[]): Bot[] {
  return bots.filter((bot) => !bot.id.startsWith("_") && !bot.archived);
}

/** Active and archived mailboxes. The mail filter uses this so an archived bot's history stays searchable. */
export function mailboxBots(bots: Bot[]): Bot[] {
  return bots.filter((bot) => !bot.id.startsWith("_"));
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [failure, setFailure] = useState<"access" | "error" | null>(null);
  useEffect(() => onAccessLost(() => setFailure("access")), []);
  useEffect(() => {
    api<Session>("/session")
      .then(setSession)
      .catch((error: { status?: number }) => setFailure(error.status === 401 ? "access" : "error"));
  }, []);
  useEffect(() => {
    if (!session) return;
    document.documentElement.style.setProperty("--accent", session.brand_accent || "#7aa2ff");
    document.title = session.brand_name || "BotMail";
  }, [session?.brand_accent, session?.brand_name]);

  if (failure === "access") return <AccessLost />;
  if (failure === "error" && !session) return <BootError />;
  if (!session) return <BootSkeleton />;
  return <Shell session={session} setSession={setSession} />;
}

function Shell({ session, setSession }: { session: Session; setSession: (next: Session) => void }) {
  const bots = useResource(() => api<{ bots: Bot[] }>("/bots?include_archived=1").then((body) => body.bots), []);
  const { path } = useLocation();
  const route = matchRoute(path);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (path === "/") navigate("/mail", { replace: true });
    setNavOpen(false);
  }, [path]);

  const pending = useRef("");
  useHotkeys(
    (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (pending.current === "g") {
        pending.current = "";
        const target = { m: "/mail", b: "/bots", r: "/routing", d: "/domains", h: "/health", s: "/settings" }[event.key];
        if (target) {
          event.preventDefault();
          navigate(target);
        }
        return;
      }
      if (event.key === "g") {
        pending.current = "g";
        setTimeout(() => (pending.current = ""), 900);
      }
    },
    [],
  );
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const state = useMemo<AppState>(() => {
    const list = bots.data ?? [];
    const shown = mailboxBots(list);
    const tally = (key: (bot: Bot) => string) => {
      const counts = new Map<string, number>();
      for (const bot of shown) counts.set(key(bot), (counts.get(key(bot)) ?? 0) + 1);
      return counts;
    };
    const nameCounts = tally((bot) => (bot.display_name || bot.id).toLowerCase());
    const localCounts = tally((bot) => bot.address_local);
    const names = new Map(
      list.map((bot) => {
        const name = bot.display_name || bot.id;
        const clash = (nameCounts.get(name.toLowerCase()) ?? 0) > 1 || (localCounts.get(bot.address_local) ?? 0) > 1;
        const label = clash && bot.domain ? `${name} · ${domainTag(bot.domain)}` : name;
        return [bot.id, bot.archived ? `${label} · archived` : label];
      }),
    );
    const addresses = new Map(list.map((bot) => [bot.id, bot.address]));
    const domains = new Set([...(session.domains ?? []).map((item) => item.domain), ...shown.map((bot) => bot.domain)]);
    return {
      session,
      setSession,
      bots: list,
      botsLoading: bots.loading && !bots.data,
      reloadBots: bots.reload,
      botName: (id: string) => (id === "_unrouted" ? "Unrouted" : names.get(id) ?? id),
      botAddress: (id: string) => addresses.get(id) ?? id,
      multiDomain: domains.size > 1,
    };
  }, [session, bots.data, bots.loading]);

  return (
    <AppContext.Provider value={state}>
      <div class={cx("app", navOpen && "nav-open")}>
        <Sidebar route={route} onPalette={() => setPaletteOpen(true)} onClose={() => setNavOpen(false)} />
        <div class="nav-scrim" onClick={() => setNavOpen(false)} />
        <main class="main">
          <div class="mobile-bar">
            <button class="icon-btn" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
              <MenuIcon size={18} />
            </button>
            <BrandMark session={session} />
            <button class="icon-btn" aria-label="Search" onClick={() => setPaletteOpen(true)}>
              <SearchIcon size={16} />
            </button>
          </div>
          <Page route={route} />
        </main>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <Toaster />
      </div>
    </AppContext.Provider>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "mail":
      return <MailPage id={route.id} />;
    case "bots":
      return <BotsPage />;
    case "bot":
      return <BotDetailPage id={route.id} />;
    case "routing":
      return <RoutingPage />;
    case "domains":
      return <DomainsPage />;
    case "health":
      return <HealthPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return (
        <div class="page page-center">
          <EmptyState
            icon={<SearchIcon size={20} />}
            title="Page not found"
            body="That address does not match a dashboard page."
            action={
              <Button variant="secondary" onClick={() => navigate("/mail")}>
                Back to mail
              </Button>
            }
          />
        </div>
      );
  }
}

const NAV: Array<{ href: string; label: string; icon: (props: { size?: number }) => ComponentChildren; match: Route["name"][]; key: string }> = [
  { href: "/mail", label: "Mail", icon: InboxIcon, match: ["mail"], key: "M" },
  { href: "/bots", label: "Bots", icon: BotIcon, match: ["bots", "bot"], key: "B" },
  { href: "/routing", label: "Routing", icon: RouteIcon, match: ["routing"], key: "R" },
  { href: "/domains", label: "Domains", icon: GlobeIcon, match: ["domains"], key: "D" },
  { href: "/health", label: "Health", icon: PulseIcon, match: ["health"], key: "H" },
  { href: "/settings", label: "Settings", icon: GearIcon, match: ["settings"], key: "S" },
];

function BrandMark({ session }: { session: Session }) {
  return (
    <a class="brand" href="/mail" onClick={linkHandler("/mail")}>
      {session.brand_logo ? (
        <img class="brand-logo" src={session.brand_logo} alt="" />
      ) : (
        <span class="brand-glyph" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 7.5h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
            <path d="m4.5 8 7.5 5.5L19.5 8" />
          </svg>
        </span>
      )}
      <span class="brand-name">{session.brand_name || "BotMail"}</span>
    </a>
  );
}

function Sidebar({ route, onPalette, onClose }: { route: Route; onPalette: () => void; onClose: () => void }) {
  const { session, bots, botsLoading, botName, multiDomain } = useApp();
  const { query } = useLocation();
  const listed = visibleBots(bots);
  const unread = listed.reduce((sum, bot) => sum + bot.unread_count, 0);
  const failing = listed.filter((bot) => bot.webhook_status === "failing").length;
  const activeBot = route.name === "mail" ? query.get("bot") ?? "" : route.name === "bot" ? route.id : "";
  return (
    <aside class="sidebar" aria-label="Primary">
      <div class="sidebar-top">
        <BrandMark session={session} />
        <button class="icon-btn sidebar-close" aria-label="Close navigation" onClick={onClose}>
          <XIcon size={16} />
        </button>
      </div>
      <button class="palette-trigger" onClick={onPalette}>
        <SearchIcon size={14} />
        <span>Jump to…</span>
        <span class="palette-keys">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <nav class="nav">
        {NAV.map((item) => {
          const active = item.match.includes(route.name);
          const Icon = item.icon;
          const count = item.href === "/mail" ? unread : item.href === "/bots" ? listed.length : 0;
          return (
            <a key={item.href} href={item.href} onClick={linkHandler(item.href)} class={cx("nav-item", active && "is-active")} aria-current={active ? "page" : undefined}>
              <Icon size={16} />
              <span class="nav-label">{item.label}</span>
              {item.href === "/health" && failing > 0 && <span class="nav-alert" title={`${failing} failing webhooks`} />}
              {count > 0 && <span class={cx("nav-count", item.href === "/mail" && "is-unread")}>{count}</span>}
            </a>
          );
        })}
      </nav>
      <div class="sidebar-section">
        <div class="sidebar-section-head">
          <span class="eyebrow">Mailboxes</span>
          <span class="eyebrow-count">{listed.length || ""}</span>
        </div>
        <div class="mailbox-list">
          {botsLoading &&
            Array.from({ length: 5 }, (_, index) => (
              <div class="mailbox-item" key={index}>
                <Skeleton width="18px" height={18} radius={6} />
                <Skeleton width={`${50 + index * 7}%`} height={10} />
              </div>
            ))}
          {groupByDomain(listed, multiDomain).map((group) => (
            <div class="mailbox-group" key={group.domain}>
              {multiDomain && (
                <div class="mailbox-group-head mono" title={group.domain}>
                  @{group.domain}
                </div>
              )}
              {group.bots.map((bot) => {
                const href = `/mail?bot=${encodeURIComponent(bot.id)}`;
                return (
                  <div key={bot.id} class={cx("mailbox-item", activeBot === bot.id && "is-active", !bot.enabled && "is-disabled")}>
                    <a class="mailbox-link" href={href} onClick={linkHandler(href)} title={bot.address} aria-label={`${bot.display_name || bot.id} inbox, ${bot.address}`} aria-current={activeBot === bot.id ? "page" : undefined} />
                    <Avatar seed={bot.id} label={bot.display_name} size={18} square />
                    <span class="mailbox-name">{multiDomain ? bot.display_name || bot.id : botName(bot.id)}</span>
                    <NotesHint notes={bot.notes} label={bot.address} />
                    {bot.unread_count > 0 && <span class="mailbox-unread">{bot.unread_count}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div class="sidebar-foot">
        <div class="user-card">
          <Avatar seed={session.email || "user"} label={session.email} size={30} />
          <div class="user-meta">
            <div class="user-email" title={session.email}>
              {session.email || "Signed in"}
            </div>
            <div class="user-via">
              <ShieldIcon size={11} /> Cloudflare Access
            </div>
          </div>
          <a class="icon-btn" href="/cdn-cgi/access/logout" title="Sign out" aria-label="Sign out">
            <LogoutIcon size={15} />
          </a>
        </div>
      </div>
    </aside>
  );
}

function groupByDomain(bots: Bot[], split: boolean): Array<{ domain: string; bots: Bot[] }> {
  if (!split) return [{ domain: "all", bots }];
  const groups = new Map<string, Bot[]>();
  for (const bot of bots) groups.set(bot.domain, [...(groups.get(bot.domain) ?? []), bot]);
  return [...groups.entries()].map(([domain, items]) => ({ domain, bots: items }));
}

type Command = { id: string; label: string; hint: string; href: string; group: string; seed?: string; avatar?: string };

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { bots, botName } = useApp();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);
  const commands = useMemo<Command[]>(() => {
    const pages = NAV.map((item) => ({ id: item.href, label: item.label, hint: `G ${item.key}`, href: item.href, group: "Pages" }));
    const botItems = visibleBots(bots).flatMap((bot) => [
      { id: `bot-${bot.id}`, label: botName(bot.id), hint: bot.address, href: `/bots/${encodeURIComponent(bot.id)}`, group: "Bots", seed: bot.id, avatar: bot.display_name || bot.id },
      { id: `mail-${bot.id}`, label: `${botName(bot.id)} inbox`, hint: bot.address, href: `/mail?bot=${encodeURIComponent(bot.id)}`, group: "Mailboxes", seed: bot.id, avatar: bot.display_name || bot.id },
    ]);
    return [...pages, ...botItems];
  }, [bots, botName]);
  const needle = query.trim().toLowerCase();
  const results = (needle ? commands.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(needle)) : commands).slice(0, 12);
  if (!open) return null;
  const choose = (item: Command | undefined) => {
    if (!item) return;
    onClose();
    navigate(item.href);
  };
  return (
    <div class="modal-backdrop palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="palette-input">
          <CommandIcon size={15} />
          <input
            ref={input}
            value={query}
            placeholder="Search pages and bots"
            aria-label="Search pages and bots"
            onInput={(event) => {
              setQuery((event.currentTarget as HTMLInputElement).value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((value) => Math.min(value + 1, results.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((value) => Math.max(value - 1, 0));
              }
              if (event.key === "Enter") choose(results[index]);
            }}
          />
          <Kbd>esc</Kbd>
        </div>
        <div class="palette-list" role="listbox">
          {results.length === 0 && <div class="palette-empty">No matches for “{query}”</div>}
          {results.map((item, position) => (
            <button
              key={item.id}
              role="option"
              aria-selected={position === index}
              class={cx("palette-item", position === index && "is-active")}
              onMouseMove={() => setIndex(position)}
              onClick={() => choose(item)}
            >
              {item.seed ? <Avatar seed={item.seed} label={item.avatar ?? item.label} size={20} square /> : <span class="palette-page-icon"><ChevronRight size={13} /></span>}
              <span class="palette-label">{item.label}</span>
              <span class="palette-group">{item.group}</span>
              <span class="palette-hint mono">{item.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function BootSkeleton() {
  return (
    <div class="app">
      <aside class="sidebar">
        <div class="sidebar-top">
          <Skeleton width="120px" height={18} />
        </div>
        <div class="nav">
          {Array.from({ length: 5 }, (_, index) => (
            <div class="nav-item" key={index}>
              <Skeleton width={`${60 + index * 6}%`} height={12} />
            </div>
          ))}
        </div>
      </aside>
      <main class="main">
        <div class="page">
          <Skeleton width="180px" height={18} />
        </div>
      </main>
    </div>
  );
}

function AccessLost() {
  return (
    <div class="gate">
      <div class="gate-card">
        <div class="gate-mark">
          <LockIcon size={18} />
        </div>
        <div class="eyebrow">Zero Trust</div>
        <h1>Access session ended</h1>
        <p>Your Cloudflare Access session expired or was revoked. Reload to sign in again with an allowed work email.</p>
        <Button variant="primary" onClick={() => location.reload()}>
          Sign in again
        </Button>
      </div>
    </div>
  );
}

function BootError() {
  return (
    <div class="gate">
      <div class="gate-card">
        <div class="gate-mark">
          <PulseIcon size={18} />
        </div>
        <div class="eyebrow">Dashboard</div>
        <h1>Could not reach the Worker</h1>
        <p>The dashboard API did not respond. Check the Worker logs, then reload.</p>
        <Button variant="primary" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  );
}
