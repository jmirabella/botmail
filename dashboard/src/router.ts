import { useEffect, useState } from "preact/hooks";

export type Route =
  | { name: "mail"; id?: string }
  | { name: "bots" }
  | { name: "bot"; id: string }
  | { name: "routing" }
  | { name: "domains" }
  | { name: "health" }
  | { name: "settings" }
  | { name: "not-found" };

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

window.addEventListener("popstate", notify);

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const current = location.pathname + location.search;
  if (to === current) return;
  if (options.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  notify();
}

export function useLocation(): { path: string; query: URLSearchParams } {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((value) => value + 1);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}

export function matchRoute(path: string): Route {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [head, id, extra] = parts;
  if (extra) return { name: "not-found" };
  if (head === "mail") return id ? { name: "mail", id } : { name: "mail" };
  if (head === "bots") return id ? { name: "bot", id } : { name: "bots" };
  if (!id && (head === "routing" || head === "domains" || head === "health" || head === "settings")) return { name: head };
  return { name: "not-found" };
}

export function linkHandler(href: string) {
  return (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
}

export function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}
