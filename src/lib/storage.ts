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
        getStore: (opts: { name: string; consistency?: "strong" | "eventual" }) => BlobsStore;
      };
      this.store = mod.getStore({ name: BLOBS_STORE_NAME, consistency: "strong" });
    }
    return this.store;
  }

  async get(key: string): Promise<string | null> {
    try {
      const v = await (await this.s()).get(key);
      return v ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await (await this.s()).set(key, value);
  }

  async del(key: string): Promise<void> {
    try {
      await (await this.s()).delete(key);
    } catch {
      /* already gone */
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const res = await (await this.s()).list({ prefix });
      return (res.blobs || []).map((b) => b.key).sort();
    } catch {
      return [];
    }
  }
}

export const kv: KV = ON_NETLIFY ? new BlobsKV() : new FsKV();
export const storageBackend = ON_NETLIFY ? "netlify-blobs" : "filesystem";
