import { kv } from "./storage";

// Member access keys persisted in the KV store ("access.json" — .data/access.json
// locally, Netlify Blobs on Netlify).
// Admin key is NOT displayed anywhere in the UI. Override in production with
// the BRNT_ADMIN_KEY env var; the fallback only exists for local dev.

const ADMIN_KEY = (process.env.BRNT_ADMIN_KEY || "brnt-admin").trim();
const STORE_KEY = "access.json";

// ---------------------------------------------------------------------------
// Built-in member accounts (Task 44)
// ---------------------------------------------------------------------------
// 50 permanent member codes baked into the app. They validate with ZERO storage
// access, so member unlock works on any deployment (Netlify included) even if
// the KV layer is broken, cold, or misconfigured. They never expire.
//
// The list is SERVER-ONLY: it lives in this module and is never imported by
// client components — the UI fetches it via the admin-gated "list-builtin"
// API action instead, so the codes are not shipped inside the public JS bundle.

export const BUILT_IN_CODES: string[] = [
  "BRNT-MEVB-NDFX",
  "BRNT-Y3LM-859T",
  "BRNT-SZXU-EC4D",
  "BRNT-KVLJ-TFZR",
  "BRNT-CVW7-DC3N",
  "BRNT-F99H-D9MY",
  "BRNT-RADA-4EUM",
  "BRNT-LD7M-S4GQ",
  "BRNT-VMRD-K64S",
  "BRNT-UJPJ-2EM8",
  "BRNT-R3W6-2JZS",
  "BRNT-2ZZT-XUGN",
  "BRNT-RBEN-93AA",
  "BRNT-6FR6-AV4G",
  "BRNT-YSBG-Q6GK",
  "BRNT-CDC4-936Z",
  "BRNT-5Y5R-YYRW",
  "BRNT-H4Z7-KT8A",
  "BRNT-2UM2-RFAL",
  "BRNT-HGCW-QSPX",
  "BRNT-AR5U-VQWQ",
  "BRNT-BZYD-KT7C",
  "BRNT-EHNA-PFCV",
  "BRNT-PKWV-YGFD",
  "BRNT-NUWS-MJSN",
  "BRNT-995E-CKHM",
  "BRNT-SXXX-RNNY",
  "BRNT-T7UD-QHUG",
  "BRNT-SJTN-KVXS",
  "BRNT-HTSW-67HC",
  "BRNT-V5NJ-RM7T",
  "BRNT-645J-Z48R",
  "BRNT-U7EN-PZAR",
  "BRNT-AZYY-99XC",
  "BRNT-5LRL-SZ2M",
  "BRNT-ULWU-E65A",
  "BRNT-LRZ7-Q9C8",
  "BRNT-Q7BK-XGMM",
  "BRNT-ZLT4-VEUB",
  "BRNT-7RTD-RGLR",
  "BRNT-8LVF-74PR",
  "BRNT-D6UA-6FJW",
  "BRNT-V6WC-AM9G",
  "BRNT-54HF-EQ4F",
  "BRNT-TMCT-P6XS",
  "BRNT-XAZP-77RS",
  "BRNT-67RA-URUY",
  "BRNT-C4Q8-UVKR",
  "BRNT-8Q9Z-2VPH",
  "BRNT-K4TM-Y3WX",
];

const BUILTIN_SET = new Set(BUILT_IN_CODES);

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
  try {
    const store = await loadStore();
    store.keys.push(record);
    await saveStore(store);
  } catch {
    // Storage write failed (e.g. Netlify Blobs unavailable on this deployment).
    // Return a clean, actionable error instead of letting the route 500.
    return {
      ok: false,
      error: "STORAGE_WRITE_UNAVAILABLE — this deployment cannot save minted keys. Use one of the 50 built-in codes instead (Show built-in codes, admin only).",
    };
  }
  return { ok: true, record };
}

export async function validateCode(code: string | undefined | null): Promise<AccessRecord | null> {
  if (!code) return null;
  const clean = String(code).trim().toUpperCase();
  // The admin key NEVER works as a member key — even if a store entry somehow
  // collides with it. Member access comes only from minted BRNT-XXXX-XXXX codes.
  if (isAdminKey(clean)) return null;

  // 1) Built-in accounts first: zero storage I/O, work on every deployment
  //    (this is what keeps member unlock alive when Netlify Blobs is broken).
  if (BUILTIN_SET.has(clean)) {
    return {
      code: clean,
      days: 0, // 0 = permanent (UI renders this as ∞)
      note: "built-in account",
      createdAt: "",
      expiresAt: "9999-12-31T23:59:59.999Z",
    };
  }

  // 2) Dynamically minted keys from the KV store. Fully guarded: a broken or
  //    hanging store degrades to "invalid key", never to a 500 / dead fetch.
  try {
    const store = await loadStore();
    const rec = store.keys.find((k) => k.code === clean);
    if (!rec) return null;
    if (isAdminKey(rec.code)) return null;
    if (Date.parse(rec.expiresAt) <= Date.now()) return null;
    return rec;
  } catch {
    return null;
  }
}

export async function purgeAdminLikeCodes(): Promise<number> {
  const store = await loadStore();
  const before = store.keys.length;
  store.keys = store.keys.filter((k) => !isAdminKey(k.code));
  if (store.keys.length !== before) await saveStore(store);
  return before - store.keys.length;
}
