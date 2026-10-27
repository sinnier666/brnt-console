import { NextRequest, NextResponse } from "next/server";
import { isAdminKey } from "@/lib/access";
import { storageBackend } from "@/lib/storage";

// Temporary admin-only storage diagnostic — probes the KV backend with raw
// error surfacing so deployment storage issues (e.g. Netlify Blobs writes
// failing with 500) can be pinpointed from one request. Safe to keep; it is
// admin-gated, uses its own store namespace, and cleans up after itself.

export async function POST(req: NextRequest) {
  let body: { adminKey?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!isAdminKey(String(body.adminKey || ""))) {
    return NextResponse.json({ ok: false, error: "INVALID_ADMIN_KEY" }, { status: 403 });
  }

  const err = (e: unknown) => String((e as Error)?.message || e).slice(0, 300);
  const backendName = storageBackend();
  const out: Record<string, unknown> = {
    ok: true,
    backend: backendName, // "netlify-blobs" | "vercel-blob" | "filesystem"
    onNetlify: backendName === "netlify-blobs",
    node: process.version,
    netlifyEnvKeys: Object.keys(process.env)
      .filter((k) => k.startsWith("NETLIFY") || k === "BRNT_ADMIN_KEY")
      .sort(),
  };

  try {
    const mod = (await import("@netlify/blobs")) as unknown as {
      getStore: (o: { name: string; consistency?: "strong" | "eventual" }) => {
        get: (k: string) => Promise<string | null | undefined>;
        set: (k: string, v: string) => Promise<void>;
        delete: (k: string) => Promise<void>;
        list: (o: { prefix: string }) => Promise<{ blobs: { key: string }[] }>;
      };
    };
    const store = mod.getStore({ name: "brnt-diag", consistency: "strong" });
    const t0 = Date.now();
    try {
      await store.set("diag.txt", `probe ${new Date().toISOString()}`);
      out.set = { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      out.set = { ok: false, error: err(e) };
    }
    try {
      const v = await store.get("diag.txt");
      out.get = { ok: true, value: String(v ?? "").slice(0, 100) };
    } catch (e) {
      out.get = { ok: false, error: err(e) };
    }
    try {
      const l = await store.list({ prefix: "diag" });
      out.list = { ok: true, count: (l.blobs || []).length };
    } catch (e) {
      out.list = { ok: false, error: err(e) };
    }
    try {
      await store.delete("diag.txt");
    } catch {
      /* best effort */
    }
  } catch (e) {
    out.storeInit = { ok: false, error: err(e) };
  }

  return NextResponse.json(out);
}
