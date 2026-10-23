import { kv } from "./storage";

// Member access keys persisted in the KV store ("access.json" — .data/access.json
// locally, Netlify Blobs on Netlify).
// Admin key is NOT displayed anywhere in the UI. Override in production with
// the BRNT_ADMIN_KEY env var; the fallback only exists for local dev.

const ADMIN_KEY = (process.env.BRNT_ADMIN_KEY || "brnt-admin").trim();
const STORE_KEY = "access.json";

export interface AccessRecord {
  code: string;
  days: number;
  note: string;
  createdAt: string;
  expiresAt: string;
}

interface AccessStore {
  keys: AccessRecord[];
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars

function randomBlock(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

async function loadStore(): Promise<AccessStore> {
  const raw = await kv.get(STORE_KEY);
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j && Array.isArray(j.keys)) return j as AccessStore;
    } catch {
      /* corrupt entry — start fresh */
    }
  }
  return { keys: [] };
}

async function saveStore(store: AccessStore): Promise<void> {
  await kv.set(STORE_KEY, JSON.stringify(store, null, 2));
}

export function isAdminKey(key: string | undefined | null): boolean {
  return typeof key === "string" && key.trim().toLowerCase() === ADMIN_KEY;
}

export async function mintKey(
  adminKey: string,
  days: number,
  note = ""
): Promise<{ ok: boolean; record?: AccessRecord; error?: string }> {
  if (!isAdminKey(adminKey)) {
    return { ok: false, error: "Invalid admin key" };
  }
  const d = [1, 3, 7].includes(days) ? days : 1;
  const now = Date.now();
  const record: AccessRecord = {
    code: `BRNT-${randomBlock(4)}-${randomBlock(4)}`,
    days: d,
    note: String(note || "").slice(0, 120),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + d * 24 * 60 * 60 * 1000).toISOString(),
  };
  const store = await loadStore();
  store.keys.push(record);
  await saveStore(store);
  return { ok: true, record };
}

export async function validateCode(code: string | undefined | null): Promise<AccessRecord | null> {
  if (!code) return null;
  const clean = String(code).trim().toUpperCase();
  // The admin key NEVER works as a member key — even if a store entry somehow
  // collides with it. Member access comes only from minted BRNT-XXXX-XXXX codes.
  if (isAdminKey(clean)) return null;
  const store = await loadStore();
  const rec = store.keys.find((k) => k.code === clean);
  if (!rec) return null;
  if (isAdminKey(rec.code)) return null;
  if (Date.parse(rec.expiresAt) <= Date.now()) return null;
  return rec;
}

export async function purgeAdminLikeCodes(): Promise<number> {
  const store = await loadStore();
  const before = store.keys.length;
  store.keys = store.keys.filter((k) => !isAdminKey(k.code));
  if (store.keys.length !== before) await saveStore(store);
  return before - store.keys.length;
}
