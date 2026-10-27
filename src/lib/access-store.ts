import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * BRNT member access keys — file-backed store (no external DB needed).
 *
 * The owner unlocks the Admin panel with a master admin key and mints
 * member access keys valid for 1, 3 or 7 days. Members paste their key
 * into the lock screen; until it expires every check API call must carry
 * it in the `x-brnt-access` header.
 *
 * Storage: JSON file under `.data/access.json` (override with BRNT_ACCESS_DB).
 * The admin master key comes from BRNT_ADMIN_KEY (default: "brnt-admin").
 * The admin key is matched case-insensitively (and trimmed) so owners who type
 * "BRNT-ADMIN" or "Brnt-Admin" are not locked out of their own console.
 */

export const ACCESS_DAYS = [1, 3, 7] as const;
export type AccessDays = (typeof ACCESS_DAYS)[number];

export interface AccessRecord {
  code: string;
  days: AccessDays;
  note: string;
  createdAt: string;
  expiresAt: string;
}

interface AccessDb {
  keys: Record<string, AccessRecord>;
}

export function adminKey(): string {
  return process.env.BRNT_ADMIN_KEY?.trim() || "brnt-admin";
}

export function isAdminKey(key: string): boolean {
  const t = (key ?? "").trim().toLowerCase();
  return t.length > 0 && t === adminKey().trim().toLowerCase();
}

function dbPath(): string {
  return process.env.BRNT_ACCESS_DB ?? path.join(process.cwd(), ".data", "access.json");
}

let cache: AccessDb | null = null;

function load(force = false): AccessDb {
  if (cache && !force) return cache;
  try {
    if (existsSync(dbPath())) {
      const parsed = JSON.parse(readFileSync(dbPath(), "utf8")) as Partial<AccessDb>;
      cache = { keys: parsed.keys ?? {} };
      return cache;
    }
  } catch {
    /* corrupted file — start fresh */
  }
  cache = { keys: {} };
  return cache;
}

function save(db: AccessDb) {
  try {
    mkdirSync(path.dirname(dbPath()), { recursive: true });
    writeFileSync(dbPath(), JSON.stringify(db, null, 2), "utf8");
  } catch {
    /* read-only fs — keys still work in memory for this process */
  }
}

/* Unambiguous alphabet: no I, L, O, 0, 1, U to avoid misread codes. */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

function randomBlock(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export function normalizeCode(raw: string): string {
  return (raw ?? "").trim().toUpperCase();
}

export function generateAccessCode(days: number, note = ""): AccessRecord {
  if (!ACCESS_DAYS.includes(days as AccessDays)) {
    throw new Error(`Access length must be one of: ${ACCESS_DAYS.join(", ")} days.`);
  }
  const db = load();
  // housekeeping: drop keys expired more than 30 days ago
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [code, rec] of Object.entries(db.keys)) {
    if (Date.parse(rec.expiresAt) < cutoff) delete db.keys[code];
  }
  let code = "";
  do {
    code = `BRNT-${randomBlock(4)}-${randomBlock(4)}`;
  } while (db.keys[code]);
  const now = Date.now();
  const record: AccessRecord = {
    code,
    days: days as AccessDays,
    note: note.slice(0, 120),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (days as AccessDays) * 24 * 60 * 60 * 1000).toISOString(),
  };
  db.keys[code] = record;
  save(db);
  return record;
}

export type AccessCheck =
  | { ok: true; admin: boolean; record: AccessRecord | null }
  | { ok: false; reason: "not-found" | "expired" };

/**
 * Validates an access key or the admin master key.
 * The admin master key always grants access (role: admin, never expires)
 * and is matched case-insensitively — see isAdminKey().
 *
 * Always re-reads the store from disk: route bundles / worker processes each
 * hold their own module state, so a key minted in another instance would be
 * invisible to a stale in-memory cache (checks would 403 right after minting).
 * The JSON file is tiny — the extra read is negligible per API call.
 */
export function verifyAccess(raw: string | null | undefined): AccessCheck {
  const t = (raw ?? "").trim();
  if (!t) return { ok: false, reason: "not-found" };
  // admin master key: case-insensitive match (never passed through normalizeCode)
  if (isAdminKey(t)) return { ok: true, admin: true, record: null };
  const rec = load(true).keys[normalizeCode(t)];
  if (!rec) return { ok: false, reason: "not-found" };
  if (Date.parse(rec.expiresAt) < Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, admin: false, record: rec };
}

export function listAccessCodes(): (AccessRecord & { status: "active" | "expired" })[] {
  const now = Date.now();
  return Object.values(load(true).keys)
    .map((r) => ({ ...r, status: Date.parse(r.expiresAt) < now ? ("expired" as const) : ("active" as const) }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
