import type { ProbeResult } from "@/lib/probe-types";

/**
 * Tiny external store for check results, persisted to localStorage.
 * Lets components subscribe via useSyncExternalStore without setState-in-effect.
 */

const STORAGE_KEY = "login-probe-results";
const MAX_RESULTS = 200;

const EMPTY: ProbeResult[] = [];

type Listener = () => void;

let listeners: Listener[] = [];
let cache: ProbeResult[] | null = null;

function read(): ProbeResult[] {
  if (cache) return cache;
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as ProbeResult[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist() {
  try {
    // Snapshots can be ~150 KB each — keep them in memory only so the
    // localStorage quota never blows up. Verdicts/evidence stay persisted.
    const slim = (cache ?? []).map((r) => (r.snapshot ? { ...r, snapshot: null } : r));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch {
    /* storage unavailable/full — keep in-memory only */
  }
}

function emit() {
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function getSnapshot(): ProbeResult[] {
  return read();
}

export function getServerSnapshot(): ProbeResult[] {
  return EMPTY;
}

export function addResult(r: ProbeResult): void {
  cache = [r, ...(cache ?? read())].slice(0, MAX_RESULTS);
  persist();
  emit();
}

/**
 * Replaces one result in place, keeping its position (used by "Run again"
 * in the detail dialog). Falls back to prepending when the id is unknown.
 */
export function replaceResult(id: string, next: ProbeResult): void {
  const list = cache ?? read();
  const idx = list.findIndex((r) => r.id === id);
  if (idx === -1) {
    cache = [next, ...list].slice(0, MAX_RESULTS);
  } else {
    cache = list.map((r) => (r.id === id ? next : r));
  }
  persist();
  emit();
}

export function clearResults(): void {
  cache = [];
  persist();
  emit();
}
