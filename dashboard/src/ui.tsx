import type { ButtonHTMLAttributes, ComponentChildren, CSSProperties, AccessibleInputHTMLAttributes, PartialInputHTMLAttributes } from "preact";
import { createPortal } from "preact/compat";
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";
import type { CheckState, DomainCheck } from "./api";
import { hueFor, initials } from "./format";
import { AlertIcon, CheckIcon, ChevronDown, CopyIcon, DotIcon, NotesIcon, XIcon } from "./icons";
import { linkHandler } from "./router";
import { toast } from "./toast";

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size" | "type" | "icon"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "accent";
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ComponentChildren;
  disabled?: boolean;
  type?: "button" | "submit";
};

export function Button({ variant = "secondary", size = "md", loading, icon, children, class: className, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      class={cx("btn", `btn-${variant}`, `btn-${size}`, loading && "is-loading", className as string)}
    >
      {loading ? <span class="spinner" aria-hidden="true" /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function LinkButton({ href, children, variant = "secondary", size = "md", icon }: { href: string; children: ComponentChildren; variant?: ButtonProps["variant"]; size?: "sm" | "md"; icon?: ComponentChildren }) {
  return (
    <a href={href} onClick={linkHandler(href)} class={cx("btn", `btn-${variant}`, `btn-${size}`)}>
      {icon}
      <span>{children}</span>
    </a>
  );
}

export function Avatar({ seed, label, size = 28, square }: { seed: string; label?: string; size?: number; square?: boolean }) {
  const hue = hueFor(seed);
  const style = {
    width: `${size}px`,
    height: `${size}px`,
    fontSize: `${Math.max(10, Math.round(size * 0.38))}px`,
    "--h": String(hue),
  } as CSSProperties;
  return (
    <span class={cx("avatar", square && "avatar-square")} style={style} aria-hidden="true">
      {initials(label || seed)}
    </span>
  );
}

export function Badge({ tone = "neutral", children, dot }: { tone?: "neutral" | "green" | "red" | "amber" | "accent" | "blue"; children: ComponentChildren; dot?: boolean }) {
  return (
    <span class={cx("badge", `badge-${tone}`)}>
      {dot && <span class="badge-dot" />}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="kbd">{children}</kbd>;
}

export async function copyText(value: string, label = "Copied to clipboard"): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast(label);
}

export function CopyButton({ value, label, size = "sm", text }: { value: string; label?: string; size?: "sm" | "md"; text?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <button
      type="button"
      class={cx("copy-btn", `copy-btn-${size}`, done && "is-done", text && "has-text")}
      aria-label={label ?? "Copy"}
      title={label ?? "Copy"}
      onClick={(event) => {
        event.stopPropagation();
        void copyText(value, label ? `${label.replace(/^Copy /, "")} copied` : "Copied to clipboard");
        setDone(true);
      }}
    >
      {done ? <CheckIcon size={13} stroke={2} /> : <CopyIcon size={13} />}
      {text && <span>{done ? "Copied" : text}</span>}
    </button>
  );
}

export function CopyField({ value, label, mono = true, masked, placeholder }: { value: string; label?: string; mono?: boolean; masked?: string; placeholder?: string }) {
  return (
    <div class={cx("copy-field", !value && "is-empty")}>
      <span class={cx("copy-field-value", mono && "mono")}>{value ? masked ?? value : placeholder ?? "Not configured"}</span>
      {value && !masked && <CopyButton value={value} label={label} />}
    </div>
  );
}

export function CodeBlock({ code, label, title }: { code: string; label?: string; title?: string }) {
  return (
    <div class="code-block">
      <div class="code-block-head">
        <span>{title ?? "Snippet"}</span>
        <CopyButton value={code} label={label ?? "Copy snippet"} text="Copy" />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ComponentChildren; children: ComponentChildren; htmlFor?: string }) {
  return (
    <div class="field">
      <label class="field-label" for={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div class="field-hint">{hint}</div>}
    </div>
  );
}

type InputProps = Omit<PartialInputHTMLAttributes<HTMLInputElement>, "prefix"> & {
  prefix?: ComponentChildren;
  suffix?: ComponentChildren;
  mono?: boolean;
};

export function Input({ prefix, suffix, mono, class: className, ...rest }: InputProps) {
  return (
    <div class={cx("input", mono && "mono", Boolean(rest.disabled) && "is-disabled", className as string)}>
      {prefix && <span class="input-affix">{prefix}</span>}
      <input {...(rest as AccessibleInputHTMLAttributes<HTMLInputElement>)} spellcheck={false} />
      {suffix && <span class="input-affix input-suffix">{suffix}</span>}
    </div>
  );
}

export function Select({ value, onChange, options, label, class: className }: { value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; label: string; class?: string }) {
  return (
    <div class={cx("select", className)}>
      <select aria-label={label} value={value} onChange={(event) => onChange((event.currentTarget as HTMLSelectElement).value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} class="select-chevron" />
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label, size = "md" }: { value: T; onChange: (value: T) => void; options: Array<{ value: T; label: ComponentChildren; count?: number }>; label: string; size?: "sm" | "md" }) {
  return (
    <div class={cx("segmented", `segmented-${size}`)} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          class={cx("segment", option.value === value && "is-active")}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && option.count > 0 && <span class="segment-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      class={cx("switch", checked && "is-on")}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
    >
      <span class="switch-thumb" />
    </button>
  );
}

export function RadioCard({ checked, onSelect, title, body, icon, children }: { checked: boolean; onSelect: () => void; title: string; body: ComponentChildren; icon?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div
      role="radio"
      tabIndex={0}
      aria-checked={checked}
      class={cx("radio-card", checked && "is-checked")}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span class="radio-mark" aria-hidden="true" />
      <div class="radio-card-main">
        <div class="radio-card-title">
          {icon}
          {title}
        </div>
        <div class="radio-card-body">{body}</div>
        {children}
      </div>
    </div>
  );
}

export function Panel({ title, eyebrow, actions, children, class: className, flush }: { title?: ComponentChildren; eyebrow?: string; actions?: ComponentChildren; children: ComponentChildren; class?: string; flush?: boolean }) {
  return (
    <section class={cx("panel", flush && "panel-flush", className)}>
      {(title || actions || eyebrow) && (
        <header class="panel-head">
          <div>
            {eyebrow && <div class="eyebrow">{eyebrow}</div>}
            {title && <h2 class="panel-title">{title}</h2>}
          </div>
          {actions && <div class="panel-actions">{actions}</div>}
        </header>
      )}
      <div class="panel-body">{children}</div>
    </section>
  );
}

export function EmptyState({ icon, title, body, action, compact }: { icon: ComponentChildren; title: string; body?: ComponentChildren; action?: ComponentChildren; compact?: boolean }) {
  return (
    <div class={cx("empty", compact && "empty-compact")}>
      <div class="empty-art" aria-hidden="true">
        <span class="empty-ring" />
        <span class="empty-icon">{icon}</span>
      </div>
      <div class="empty-title">{title}</div>
      {body && <div class="empty-body">{body}</div>}
      {action && <div class="empty-action">{action}</div>}
    </div>
  );
}

export function Skeleton({ width, height = 12, radius }: { width?: string; height?: number; radius?: number }) {
  return <span class="skeleton" style={{ width: width ?? "100%", height: `${height}px`, borderRadius: radius ? `${radius}px` : undefined }} />;
}

export function SkeletonRows({ rows = 6, avatar = true }: { rows?: number; avatar?: boolean }) {
  return (
    <div class="skeleton-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div class="skeleton-row" key={index}>
          {avatar && <Skeleton width="28px" height={28} radius={8} />}
          <div class="skeleton-lines">
            <Skeleton width={`${40 + ((index * 17) % 35)}%`} height={11} />
            <Skeleton width={`${70 + ((index * 11) % 25)}%`} height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, description, children, footer, width = 480 }: { open: boolean; onClose: () => void; title: string; description?: ComponentChildren; children?: ComponentChildren; footer?: ComponentChildren; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusable = node?.querySelector<HTMLElement>("input, textarea, select, button:not(.modal-close)");
    (focusable ?? node)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
      if (event.key === "Tab" && node) {
        const items = [...node.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, textarea, select, [tabindex='0']")];
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div class="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1} style={{ maxWidth: `${width}px` }}>
        <header class="modal-head">
          <div>
            <h2 class="modal-title">{title}</h2>
            {description && <p class="modal-desc">{description}</p>}
          </div>
          <button class="icon-btn modal-close" aria-label="Close" onClick={onClose}>
            <XIcon size={15} />
          </button>
        </header>
        {children && <div class="modal-body">{children}</div>}
        {footer && <footer class="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ComponentChildren; subtitle?: ComponentChildren; actions?: ComponentChildren; back?: ComponentChildren }) {
  return (
    <header class="page-head">
      <div class="page-head-main">
        {back}
        <div class="page-head-text">
          <h1 class="page-title">{title}</h1>
          {subtitle && <div class="page-subtitle">{subtitle}</div>}
        </div>
      </div>
      {actions && <div class="page-actions">{actions}</div>}
    </header>
  );
}

export type Resource<T> = { data: T | undefined; error: Error | undefined; loading: boolean; reload: () => Promise<void>; mutate: (next: T | ((current: T | undefined) => T)) => void };

export function useResource<T>(loader: () => Promise<T>, deps: unknown[]): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const next = await loader();
      if (mine !== generation.current) return;
      setData(next);
      setError(undefined);
    } catch (caught) {
      if (mine !== generation.current) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  const mutate = useCallback((next: T | ((current: T | undefined) => T)) => {
    setData((current) => (typeof next === "function" ? (next as (value: T | undefined) => T)(current) : next));
  }, []);
  return { data, error, loading, reload, mutate };
}

export function ArchiveToggle({ pressed, count, onToggle }: { pressed: boolean; count: number; onToggle: () => void }) {
  if (!pressed && count === 0) return null;
  return (
    <button type="button" class={cx("chip", pressed && "is-active")} aria-pressed={pressed} onClick={onToggle}>
      {pressed ? "Hide archived" : `Show archived (${count})`}
    </button>
  );
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  return node.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName);
}

export function useHotkeys(handler: (event: KeyboardEvent) => void, deps: unknown[]): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      if (document.querySelector(".modal-backdrop")) return;
      handler(event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, deps);
}

export function ErrorNote({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div class="error-note" role="alert">
      <span>{error.message}</span>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Textarea({ value, onInput, placeholder, rows = 4, maxLength, id, label }: { value: string; onInput: (value: string) => void; placeholder?: string; rows?: number; maxLength?: number; id?: string; label?: string }) {
  return (
    <div class="textarea">
      <textarea id={id} aria-label={label} value={value} rows={rows} maxLength={maxLength} placeholder={placeholder} onInput={(event) => onInput((event.currentTarget as HTMLTextAreaElement).value)} />
      {maxLength && value.length > maxLength * 0.8 && (
        <span class="textarea-count mono">
          {value.length}/{maxLength}
        </span>
      )}
    </div>
  );
}

/** A notes icon next to a mailbox name. Hover or focus previews the note; a tap pins it open on touch screens. */
export function NotesHint({ notes, label }: { notes: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number; above: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const show = useCallback(() => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(300, window.innerWidth - 24);
    const above = rect.bottom + 180 > window.innerHeight && rect.top > 200;
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12);
    setPlace({ top: above ? rect.top - 8 : rect.bottom + 8, left, above });
    setOpen(true);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setPinned(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    const onPointer = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  if (!notes.trim()) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        class={cx("notes-hint", open && "is-open")}
        aria-label={`Notes for ${label}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={() => !pinned && setOpen(false)}
        onFocus={show}
        onBlur={() => !pinned && setOpen(false)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (pinned) {
            setPinned(false);
            setOpen(false);
          } else {
            setPinned(true);
            show();
          }
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <NotesIcon size={13} />
      </button>
      {open &&
        place &&
        createPortal(
          <div id={id} role="tooltip" class={cx("notes-pop", place.above && "is-above")} style={{ top: `${place.top}px`, left: `${place.left}px` }}>
            <div class="notes-pop-head">
              <NotesIcon size={12} /> {label}
            </div>
            <div class="notes-pop-body">{notes}</div>
          </div>,
          document.body,
        )}
    </>
  );
}

const STATE_COPY: Record<CheckState, { tone: "green" | "red" | "amber" | "neutral" | "blue"; label: string }> = {
  ok: { tone: "green", label: "Ready" },
  error: { tone: "red", label: "Issue" },
  pending: { tone: "amber", label: "Pending" },
  manual: { tone: "blue", label: "Manual" },
  skipped: { tone: "neutral", label: "Skipped" },
};

export function StateBadge({ state, label }: { state: CheckState; label?: string }) {
  const copy = STATE_COPY[state] ?? STATE_COPY.pending;
  return (
    <Badge tone={copy.tone} dot>
      {label ? `${label} · ${copy.label.toLowerCase()}` : copy.label}
    </Badge>
  );
}

const CHECK_NAMES: Record<string, string> = {
  routing: "Routing",
  routing_dns: "Routing DNS",
  catch_all: "Catch-all",
  sending: "Sending",
  dns_mx: "Inbound MX",
  dns_return: "Return MX",
  dns_spf: "SPF",
  dns_dkim: "DKIM",
  dns_dmarc: "DMARC",
};

export function checkName(item: DomainCheck): string {
  return CHECK_NAMES[item.id] ?? item.label;
}

export function CheckList({ checks }: { checks: DomainCheck[] }) {
  return (
    <ul class="checks">
      {checks.map((item) => (
        <li class="check" key={item.id} title={item.label}>
          <span class={cx("check-icon", item.state === "ok" ? "is-ok" : item.state === "error" ? "is-bad" : "is-wait")}>
            {item.state === "ok" ? <CheckIcon size={12} stroke={2.2} /> : item.state === "error" ? <XIcon size={12} stroke={2.2} /> : item.state === "manual" ? <AlertIcon size={12} /> : <DotIcon size={12} />}
          </span>
          <span class="check-label">{checkName(item)}</span>
          <span class="check-detail mono" title={item.detail}>
            {item.detail}
          </span>
          <StateBadge state={item.state} />
        </li>
      ))}
    </ul>
  );
}
