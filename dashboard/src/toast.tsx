import { useEffect, useState } from "preact/hooks";
import { AlertIcon, CheckIcon, XIcon } from "./icons";

type Toast = { id: number; kind: "success" | "error" | "info"; title: string; detail?: string };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<(items: Toast[]) => void>();

function publish(): void {
  for (const listener of listeners) listener(toasts);
}

function dismiss(id: number): void {
  toasts = toasts.filter((item) => item.id !== id);
  publish();
}

export function toast(title: string, options: { kind?: Toast["kind"]; detail?: string } = {}): void {
  const item: Toast = { id: nextId++, kind: options.kind ?? "success", title, detail: options.detail };
  toasts = [...toasts.slice(-3), item];
  publish();
  setTimeout(() => dismiss(item.id), item.kind === "error" ? 6500 : 3600);
}

export function toastError(error: unknown, title = "Something went wrong"): void {
  toast(title, { kind: "error", detail: error instanceof Error ? error.message : String(error) });
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setItems);
    return () => listeners.delete(setItems);
  }, []);
  return (
    <div class="toaster" role="region" aria-live="polite" aria-label="Notifications">
      {items.map((item) => (
        <div key={item.id} class={`toast toast-${item.kind}`} role={item.kind === "error" ? "alert" : "status"}>
          <span class="toast-icon">{item.kind === "error" ? <AlertIcon size={14} /> : <CheckIcon size={14} stroke={2} />}</span>
          <div class="toast-body">
            <div class="toast-title">{item.title}</div>
            {item.detail && <div class="toast-detail">{item.detail}</div>}
          </div>
          <button class="toast-close" aria-label="Dismiss" onClick={() => dismiss(item.id)}>
            <XIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
