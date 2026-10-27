import type { AccessDays } from "@/lib/access-store";

/**
 * Client-side member-access state as a tiny external store
 * (useSyncExternalStore-friendly, persisted to localStorage).
 * A `null` snapshot means the console is locked.
 */

export interface AccessInfo {
  code: string;
  role: "member" | "admin";
  days: AccessDays | null;
  /** Epoch ms; null = never expires (admin master key). */
  expiresAt: number | null;
}

const STORAGE_KEY = "brnt-access-v1";

const listeners: (() => void)[] = [];
let cache: AccessInfo | null | undefined; // undefined = not read yet

function read(): AccessInfo | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AccessInfo;
    if (!parsed || typeof parsed.code !== "string" || !parsed.code) return null;
    if (parsed.expiresAt !== null && parsed.expiresAt < Date.now()) return null; // expired → locked
    return parsed;
  } catch {
    return null;
  }
}

function persist(info: AccessInfo | null) {
  try {
    if (info) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — session-only access */
  }
}

function emit() {
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function getAccessSnapshot(): AccessInfo | null {
  if (cache === undefined) cache = read();
  return cache;
}

/** Stable server snapshot → always locked during SSR. */
export function getServerAccessSnapshot(): AccessInfo | null {
  return null;
}

export function setAccess(info: AccessInfo): void {
  cache = info;
  persist(info);
  emit();
}

export function clearAccess(): void {
  cache = null;
  persist(null);
  emit();
}

/** Headers to attach to every /api/check-login call. */
export function accessHeader(): Record<string, string> {
  const a = getAccessSnapshot();
  return a ? { "x-brnt-access": a.code } : {};
}

export function formatRemaining(expiresAt: number | null): string {
  if (expiresAt === null) return "no expiry";
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  if (d > 0) return `${d}d ${h}h left`;
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}
