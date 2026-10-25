import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

// KV storage for the console's server-side state.
//
// - On Vercel: Vercel Blob (selected when BLOB_READ_WRITE_TOKEN is present —
//   Vercel injects that token automatically once a Blob store is connected to
//   the project). Values are encrypted at rest: Blob stores are served via
//   public URLs, and this app stores session cookies, so plaintext is not ok.
// - On Netlify: Netlify Blobs — persists across serverless invocations and
//   deploys, no external database account needed.
// - Everywhere else (localhost dev / container hosting): the local .data/
//   folder (same layout as before, so existing local data keeps working).
//
// Keys are flat, slash-separated paths:
//   "access.json" · "live-sessions.json" · "logs/usage-YYYY-MM-DD.txt" ·
//   "sessions/<createdAt36>-<id>.json"

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  /** All keys that start with the prefix (slash-separated). */
  list(prefix: string): Promise<string[]>;
}

// ---------------- backend selection (ROBUST platform detection) ----------------
//
// Historic bug (caught in production): we selected the backend with
// `process.env.NETLIFY === "true"`, but the current Netlify Next.js runtime
// does NOT set that variable inside the function environment. Result: the
// FILESYSTEM backend ran on Netlify and tried `mkdir /var/task/.data` on the
// read-only Lambda fs -> ENOENT on every write.
//
// Reliable signals, checked lazily, in order:
//   1. process.env.BLOB_READ_WRITE_TOKEN   (Vercel Blob — injected by Vercel
//      when a Blob store is connected to the project; nobody sets this on
//      Netlify or locally, so it is an unambiguous signal)
//   2. Netlify: NETLIFY==="true" | NETLIFY_BLOBS_CONTEXT | netlifyBlobsContext
//      global (the same places the @netlify/blobs client itself reads)
//   3. Fallback: filesystem .data/ (localhost / container hosting)
// The filesystem fallback must never run on serverless platforms — both
// Netlify Lambdas and Vercel functions have a read-only /var/task — hence
// every serverless platform above MUST be detected explicitly.

function detectBlobsContext(): boolean {
  if (process.env.NETLIFY === "true") return true;
  if (process.env.NETLIFY_BLOBS_CONTEXT) return true;
  try {
    return Boolean((globalThis as { netlifyBlobsContext?: unknown }).netlifyBlobsContext);
  } catch {
    return false;
  }
}

function hasVercelBlobToken(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

let backend: KV | null = null;

function kvBackend(): KV {
  if (!backend) {
    if (hasVercelBlobToken()) backend = new VercelBlobKV();
    else if (detectBlobsContext()) backend = new BlobsKV();
    else backend = new FsKV();
  }
  return backend;
}

// ---------------- filesystem backend (.data/<key>) ----------------

class FsKV implements KV {
  private root = path.join(process.cwd(), ".data");

  private fileFor(key: string): string {
    // prevent path escape from crafted keys
    const clean = key.replace(/\.\.+/g, ".").replace(/^\/+/, "");
    return path.join(this.root, clean);
  }

  async get(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.fileFor(key), "utf8");
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const file = this.fileFor(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value, "utf8");
  }

  async del(key: string): Promise<void> {
    await fs.rm(this.fileFor(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string) => {
      const dir = rel ? path.join(this.root, rel) : this.root;
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(child);
        else if (child.startsWith(prefix)) out.push(child);
      }
    };
    await walk("");
    return out.sort();
  }
}

// ---------------- Netlify Blobs backend ----------------
//
// ⚠ Root cause of the historic "all writes 500 on Netlify" bug (found in the
// @netlify/blobs v11 client source): a store created with
// `consistency: "strong"` throws BlobsConsistencyError on EVERY operation when
// the deployment's Blobs context carries no `uncachedEdgeURL` — which is the
// case on this site's deploys. Reads swallowed the throw (panel looked empty
// but "fine"); writes propagated it as HTTP 500.
//
// Fix: use the default "eventual" consistency. Per Netlify docs, writes are
// readable immediately (new/changed objects), updates/deletes propagate to the
// edge within ~60s — acceptable for this app (mint→verify is read-after-write
// on the same invocation path, and the 50 built-in codes bypass storage).

// Minimal structural type — avoids bundling @netlify/blobs types into builds
// that never use it (the import below is dynamic and only runs on Netlify).
interface BlobsStore {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string }): Promise<{ blobs: { key: string }[] }>;
}

const BLOBS_STORE_NAME = "brnt-data";

class BlobsKV implements KV {
  private store: BlobsStore | null = null;

  private async s(): Promise<BlobsStore> {
    if (!this.store) {
      const mod = (await import("@netlify/blobs")) as unknown as {
        getStore: (opts: { name: string }) => BlobsStore;
      };
      // NO consistency option — "strong" hard-fails on deploys whose Blobs
      // context lacks uncachedEdgeURL (see comment above). Eventual default.
      this.store = mod.getStore({ name: BLOBS_STORE_NAME });
    }
    return this.store;
  }

  async get(key: string): Promise<string | null> {
    try {
      const v = await (await this.s()).get(key);
      return v ?? null;
    } catch (e) {
      // A missing key returns null WITHOUT throwing; a throw is a real
      // failure. Log it (visible in Netlify function logs) but keep the
      // read path non-fatal so the UI degrades gracefully.
      console.error(`[blobs] get failed for "${key}":`, e);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await (await this.s()).set(key, value);
    } catch (e) {
      console.error(`[blobs] set failed for "${key}":`, e);
      throw e; // callers surface this as STORAGE_WRITE_FAILED
    }
  }

  async del(key: string): Promise<void> {
    try {
      await (await this.s()).delete(key);
    } catch (e) {
      console.error(`[blobs] delete failed for "${key}":`, e);
      /* treat as already gone */
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const res = await (await this.s()).list({ prefix });
      return (res.blobs || []).map((b) => b.key).sort();
    } catch (e) {
      console.error(`[blobs] list failed for "${prefix}":`, e);
      return [];
    }
  }
}

// ---------------- Vercel Blob backend ----------------
//
// @vercel/blob has no server-side get(): reads are head(pathname) -> URL ->
// fetch(url). URLs of Blob stores are public (unguessable store host, but a
// deterministic pathname is NOT a secret) — so every value is encrypted with
// AES-256-GCM before it leaves the function. The encryption key is derived
// from BRNT_BLOB_SECRET (if set) or BLOB_READ_WRITE_TOKEN itself — both
// server-only env vars, never exposed to the browser.
//
// addRandomSuffix:false keeps pathnames identical to KV keys, so list(prefix)
// maps 1:1 to the KV contract (same as Blobs and FsKV).

// Minimal structural types — avoids importing @vercel/blob types statically.
interface VercelBlobHead {
  url: string;
  pathname: string;
}
interface VercelBlobMod {
  put: (
    pathname: string,
    body: string,
    opts: { access: "public"; addRandomSuffix: boolean; contentType: string },
  ) => Promise<VercelBlobHead>;
  head: (pathnameOrUrl: string) => Promise<VercelBlobHead>;
  del: (urls: string | string[]) => Promise<void>;
  list: (opts: { prefix?: string; cursor?: string; limit?: number }) => Promise<{
    blobs: VercelBlobHead[];
    cursor?: string;
    hasMore: boolean;
  }>;
}

const BLOB_ENC_PREFIX = "brntenc1:";
let blobKeyCache: Buffer | null = null;

function blobCryptoKey(): Buffer {
  if (!blobKeyCache) {
    const secret =
      process.env.BRNT_BLOB_SECRET || process.env.BLOB_READ_WRITE_TOKEN || "brnt-fallback";
    // Deterministic derivation — data must stay decryptable across cold starts.
    blobKeyCache = crypto.scryptSync(secret, "brnt-blob-salt-v1", 32);
  }
  return blobKeyCache;
}

function encryptValue(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", blobCryptoKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return BLOB_ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

function decryptValue(stored: string): string {
  if (!stored.startsWith(BLOB_ENC_PREFIX)) return stored; // plaintext (pre-encryption write) — pass through
  const raw = Buffer.from(stored.slice(BLOB_ENC_PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", blobCryptoKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

class VercelBlobKV implements KV {
  private mod: VercelBlobMod | null = null;

  private async m(): Promise<VercelBlobMod> {
    if (!this.mod) {
      const mod = (await import("@vercel/blob")) as unknown as VercelBlobMod;
      this.mod = mod;
    }
    return this.mod;
  }

  async get(key: string): Promise<string | null> {
    try {
      const m = await this.m();
      let url: string;
      try {
        const h = await m.head(key); // throws when the blob does not exist
        url = h.url;
      } catch {
        return null; // missing key — normal case
      }
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        console.error(`[vercel-blob] get "${key}": fetch ${res.status}`);
        return null;
      }
      const stored = await res.text();
      try {
        return decryptValue(stored);
      } catch (e) {
        // Wrong key (token rotated / secret changed) — treat as missing data.
        console.error(`[vercel-blob] decrypt failed for "${key}":`, e);
        return null;
      }
    } catch (e) {
      console.error(`[vercel-blob] get failed for "${key}":`, e);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      const m = await this.m();
      await m.put(key, encryptValue(value), {
        access: "public",
        addRandomSuffix: false, // pathnames must equal KV keys
        contentType: "text/plain; charset=utf-8",
      });
    } catch (e) {
      console.error(`[vercel-blob] set failed for "${key}":`, e);
      throw e; // callers surface this as STORAGE_WRITE_FAILED
    }
  }

  async del(key: string): Promise<void> {
    try {
      const m = await this.m();
      let url: string;
      try {
        url = (await m.head(key)).url;
      } catch {
        return; // already gone
      }
      await m.del([url]);
    } catch (e) {
      console.error(`[vercel-blob] delete failed for "${key}":`, e);
      /* treat as already gone */
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    try {
      const m = await this.m();
      let cursor: string | undefined;
      // page through — default limit is 1000, sessions accumulate over time
      do {
        const page = await m.list({ prefix, cursor, limit: 1000 });
        for (const b of page.blobs) {
          if (b.pathname.startsWith(prefix)) out.push(b.pathname);
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    } catch (e) {
      console.error(`[vercel-blob] list failed for "${prefix}":`, e);
      return [];
    }
    return out.sort();
  }
}

export const kv: KV = {
  get: (key) => kvBackend().get(key),
  set: (key, value) => kvBackend().set(key, value),
  del: (key) => kvBackend().del(key),
  list: (prefix) => kvBackend().list(prefix),
};

export function storageBackend(): "vercel-blob" | "netlify-blobs" | "filesystem" {
  if (hasVercelBlobToken()) return "vercel-blob";
  return detectBlobsContext() ? "netlify-blobs" : "filesystem";
}
