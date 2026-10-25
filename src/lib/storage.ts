import { promises as fs } from "fs";
import path from "path";

// KV storage for the console's server-side state.
//
// - On Netlify (process.env.NETLIFY === "true"): Netlify Blobs — persists across
//   serverless invocations and deploys, no external database account needed.
// - Everywhere else (localhost dev / container hosting): the local .data/ folder
//   (same layout as before, so existing local data keeps working).
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

export const ON_NETLIFY = process.env.NETLIFY === "true";

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

export const kv: KV = ON_NETLIFY ? new BlobsKV() : new FsKV();
export const storageBackend = ON_NETLIFY ? "netlify-blobs" : "filesystem";
