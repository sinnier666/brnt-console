import { CookieJar } from "./cookies";
import { kv } from "./storage";

export interface ReplaySession {
  id: string;
  jar: CookieJar;
  target: string;
  createdAt: number;
  lastAccess: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// Sessions live in TWO layers:
//   L1 — in-memory Map (fast path, per process)
//   L2 — the KV store ("sessions/<createdAt36>-<id>.json") so replay/NFT jar
//        data survives serverless invocations on Netlify and process restarts.
// The KV key carries the creation time so expired entries can be swept without
// reading their bodies.

const GLOBAL_KEY = "__brntReplaySessions";
const g = globalThis as unknown as { [GLOBAL_KEY]?: Map<string, ReplaySession> };
const sessions: Map<string, ReplaySession> = g[GLOBAL_KEY] || new Map();
g[GLOBAL_KEY] = sessions;
let lastSweep = Date.now();

interface StoredSession {
  id: string;
  target: string;
  createdAt: number;
  jar: { cookies: Parameters<CookieJar["seedParsed"]>[0] };
}

function kvKey(createdAt: number, id: string): string {
  return `sessions/${createdAt.toString(36)}-${id}.json`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

async function sweepKv(now: number): Promise<void> {
  try {
    const keys = await kv.list("sessions/");
    for (const key of keys) {
      const m = /^sessions\/([0-9a-z]+)-.+\.json$/.exec(key);
      if (!m) continue;
      const createdAt = parseInt(m[1], 36);
      if (Number.isFinite(createdAt) && now - createdAt > TTL_MS) {
        await kv.del(key);
      }
    }
  } catch {
    /* non-fatal */
  }
}

function sweep() {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [id, s] of sessions) {
    if (now - s.createdAt > TTL_MS) sessions.delete(id);
  }
  void sweepKv(now);
}

function hydrate(id: string, raw: string, now: number): ReplaySession | null {
  try {
    const j = JSON.parse(raw) as StoredSession;
    if (!j || !j.target || !Array.isArray(j.jar?.cookies)) return null;
    const jar = new CookieJar();
    jar.seedParsed(j.jar.cookies, hostOf(j.target));
    const s: ReplaySession = {
      id: j.id || id,
      jar,
      target: j.target,
      createdAt: j.createdAt || now,
      lastAccess: now,
    };
    sessions.set(id, s);
    return s;
  } catch {
    return null;
  }
}

export async function createSession(target: string, jar: CookieJar): Promise<ReplaySession> {
  sweep();
  const id =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  const s: ReplaySession = { id, jar, target, createdAt: Date.now(), lastAccess: Date.now() };
  sessions.set(id, s);
  try {
    const stored: StoredSession = {
      id,
      target,
      createdAt: s.createdAt,
      jar: jar.toJSON() as { cookies: Parameters<CookieJar["seedParsed"]>[0] },
    };
    await kv.set(kvKey(s.createdAt, id), JSON.stringify(stored));
  } catch {
    /* in-memory copy still works this invocation */
  }
  return s;
}

export async function getSession(id: string): Promise<ReplaySession | null> {
  sweep();
  const hit = sessions.get(id);
  if (hit) {
    hit.lastAccess = Date.now();
    return hit;
  }
  // L1 miss — look in the KV store (key starts with createdAt but we only know
  // the id, so match by listing the small id suffix).
  try {
    const keys = await kv.list("sessions/");
    const key = keys.find((k) => k.endsWith(`-${id}.json`));
    if (!key) return null;
    const raw = await kv.get(key);
    if (!raw) return null;
    const s = hydrate(id, raw, Date.now());
    return s;
  } catch {
    return null;
  }
}
