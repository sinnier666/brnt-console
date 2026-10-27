import { promises as fs } from "fs";
import path from "path";

// KV storage for the console's server-side state.
//
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

// ---------------- backend selection (ROBUST Netlify detection) ----------------
//
// Historic bug (caught in production): we selected the backend with
// `process.env.NETLIFY === "true"`, but the current Netlify Next.js runtime
// does NOT set that variable inside the function environment. Result: the
// FILESYSTEM backend ran on Netlify and tried `mkdir /var/task/.data` on the
// read-only Lambda fs -> ENOENT on every write.
//
// Reliable signals that we run on Netlify (checked lazily, in order):
//   1. process.env.NETLIFY === "true"                    (classic signal)
//   2. process.env.NETLIFY_BLOBS_CONTEXT                 (Blobs credentials env)
//   3. globalThis.netlifyBlobsContext                    (Blobs bootstrap global —
//     the same two places the @netlify/blobs client itself reads)
// On plain localhost / containers none of these exist -> filesystem backend.

function detectBlobsContext(): boolean {
  if (process.env.NETLIFY === "true") return true;
  if (process.env.NETLIFY_BLOBS_CONTEXT) return true;
  try {
    return Boolean((globalThis as { netlifyBlobsContext?: unknown }).netlifyBlobsContext);
  } catch {
    return false;
  }
}

let backend: KV | null = null;

function kvBackend(): KV {
  if (!backend) {
    // 1) Netlify -> Netlify Blobs (native, persistent).
    // 2) Vercel (or any host with a BLOB_READ_WRITE_TOKEN) -> Vercel Blob
    //    (persistent, SHARED by every serverless instance — fixes the bug
    //    where live sessions lived in one instance's ephemeral disk so some
    //    visitors saw the pool and others saw it empty, and redeploys wiped it).
    // 3) Local dev / containers -> filesystem .data/ (unchanged).
    backend = detectBlobsContext()
      ? new BlobsKV()
      : process.env.BLOB_READ_WRITE_TOKEN
        ? new VercelBlobKV()
        : new FsKV();
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

// ---------------- Vercel Blob backend (@vercel/blob) ----------------

// Vercel's serverless filesystem is EPHEMERAL: each lambda instance has its
// own .data folder and redeploys throw it away. Vercel Blob is real persistent
// storage shared by every instance, so the live-session pool, minted member
// keys, replay sessions and usage logs all survive redeploys and are visible
// from every request no matter which instance serves it.

const VBLOB_NS = "brnt-data/";

class VercelBlobKV implements KV {
  private sdkP: Promise<
    typeof import("@vercel/blob")
  > | null = null;

  /** Lazy dynamic import — keeps the SDK out of bundles that never use it. */
  private async sdk() {
    if (!this.sdkP) this.sdkP = import("@vercel/blob");
    return this.sdkP;
  }

  /** Logical KV key -> namespaced blob pathname (shared-store safety). */
  private static k(key: string) {
    return VBLOB_NS + key.replace(/^\/+/, "");
  }

  async get(key: string): Promise<string | null> {
    try {
      const m = await this.sdk();
      const res = await m.get(VercelBlobKV.k(key), { access: "public" });
      if (!res || res.statusCode !== 200 || !res.stream) return null;
      return await new Response(res.stream).text();
    } catch (e) {
      // Missing keys resolve to null without throwing here; a throw is a real
      // failure. Degrade gracefully (same contract as BlobsKV.get).
      console.error(`[vercel-blob] get failed for "${key}":`, e);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      const m = await this.sdk();
      await m.put(VercelBlobKV.k(key), value, {
        access: "public",
        addRandomSuffix: false, // same key must map to the same blob
        allowOverwrite: true, // and updates must be able to replace it
        contentType: "application/json",
      });
    } catch (e) {
      console.error(`[vercel-blob] set failed for "${key}":`, e);
      throw e; // callers surface this as STORAGE_WRITE_FAILED
    }
  }

  async del(key: string): Promise<void> {
    try {
      const m = await this.sdk();
      await m.del(VercelBlobKV.k(key));
    } catch (e) {
      console.error(`[vercel-blob] delete failed for "${key}":`, e);
      /* treat as already gone */
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const m = await this.sdk();
      const out: string[] = [];
      let cursor: string | undefined = undefined;
      // cursor loop: the SDK pages at 1000 entries; guard caps pathological loops
      for (let i = 0; i < 50; i++) {
        const res = await m.list({ prefix: VercelBlobKV.k(prefix), cursor, limit: 1000 });
        for (const b of res.blobs || []) {
          const name = b.pathname.startsWith(VBLOB_NS)
            ? b.pathname.slice(VBLOB_NS.length)
            : b.pathname;
          out.push(name);
        }
        if (!res.hasMore || !res.cursor) break;
        cursor = res.cursor;
      }
      return out.sort();
    } catch (e) {
      console.error(`[vercel-blob] list failed for "${prefix}":`, e);
      return [];
    }
  }
}

export const kv: KV = {
  get: (key) => kvBackend().get(key),
  set: (key, value) => kvBackend().set(key, value),
  del: (key) => kvBackend().del(key),
  list: (prefix) => kvBackend().list(prefix),
};

export function storageBackend(): "netlify-blobs" | "vercel-blob" | "filesystem" {
  if (detectBlobsContext()) return "netlify-blobs";
  if (process.env.BLOB_READ_WRITE_TOKEN) return "vercel-blob";
  return "filesystem";
}
