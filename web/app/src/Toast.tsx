// Shared toast system — one ToastHost mounted at the app root + a dependency-free imperative
// API (`toast(...)`) backed by a tiny module-level store. Replaces the old persistent inline
// `.status` banners: ok/error toasts auto-dismiss after 12s (pause on hover), busy toasts persist
// until replaced/resolved by a later call reusing the same `id`. Success toasts carrying a tx
// `hash` (+ explorer) render a "View transaction ↗" link.
import { useEffect, useState } from "react";

export type ToastKind = "ok" | "error" | "busy";
export interface ToastInput {
  kind: ToastKind;
  msg: string;
  hash?: string;
  /** Block-explorer base URL — pairs with `hash` to render a tx link. */
  explorer?: string;
  /** Stable id to REPLACE an existing toast (busy → ok/error). Omit for a fresh toast. */
  id?: string;
}
export interface ToastItem extends Required<Pick<ToastInput, "kind" | "msg">> {
  id: string;
  hash?: string;
  explorer?: string;
}

const AUTO_MS = 12000;
type Listener = (items: ToastItem[]) => void;
const listeners = new Set<Listener>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let items: ToastItem[] = [];
let seq = 0;

function emit() { const snap = [...items]; for (const l of listeners) l(snap); }

/** (Re)arm the auto-dismiss timer for a toast. Busy toasts never auto-dismiss. */
function arm(id: string, kind: ToastKind) {
  const prev = timers.get(id);
  if (prev) { clearTimeout(prev); timers.delete(id); }
  if (kind === "busy") return;
  timers.set(id, setTimeout(() => dismiss(id), AUTO_MS));
}

export function dismiss(id: string) {
  const t = timers.get(id);
  if (t) { clearTimeout(t); timers.delete(id); }
  if (!items.some((x) => x.id === id)) return;
  items = items.filter((x) => x.id !== id);
  emit();
}

/** Create a toast (or replace one with the same `id`). Returns the id so callers can resolve it. */
export function toast(input: ToastInput): string {
  const id = input.id ?? `t${++seq}`;
  const next: ToastItem = { id, kind: input.kind, msg: input.msg, hash: input.hash, explorer: input.explorer };
  const idx = items.findIndex((x) => x.id === id);
  items = idx >= 0 ? items.map((x) => (x.id === id ? next : x)) : [...items, next];
  emit();
  arm(id, input.kind);
  return id;
}

/** Pause / resume auto-dismiss (used for hover-to-hold). */
export function hold(id: string) { const t = timers.get(id); if (t) { clearTimeout(t); timers.delete(id); } }
export function release(id: string) { const it = items.find((x) => x.id === id); if (it && !timers.has(id)) arm(id, it.kind); }

function subscribe(l: Listener) { listeners.add(l); l([...items]); return () => { listeners.delete(l); }; }

function Spinner() { return <span className="spin" />; }

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>([]);
  useEffect(() => subscribe(setList), []);
  if (list.length === 0) return null;
  return (
    <div className="toast-host" role="region" aria-label="Notifications">
      {list.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role={t.kind === "error" ? "alert" : "status"}
          onMouseEnter={() => hold(t.id)}
          onMouseLeave={() => release(t.id)}
        >
          <span className="toast-ico" aria-hidden>
            {t.kind === "busy" ? <Spinner /> : t.kind === "ok" ? "✓" : "✕"}
          </span>
          <div className="toast-body">
            <span className="toast-msg">{t.msg}</span>
            {t.hash && t.explorer && (
              <a className="toast-link" href={`${t.explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a>
            )}
          </div>
          <button className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
