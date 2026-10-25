import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session-store";

const BLOCKED_RESP_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "strict-transport-security",
  "set-cookie", // jar already captured them server-side
]);

function targetFromPath(pathSegs: string[], search: string): string | null {
  // path: /<scheme>/<host>[:<port>][/...rest]
  if (pathSegs.length < 2) return null;
  const [scheme, host, ...rest] = pathSegs;
  if (!/^(https?|http)$/.test(scheme)) return null;
  const cleanRest = rest.map((s) => decodeURIComponent(s)).join("/");
  try {
    const u = new URL(`${scheme}://${host}/${cleanRest}`);
    if (search) u.search = search;
    return u.href;
  } catch {
    return null;
  }
}

async function proxy(
  id: string,
  pathSegs: string[],
  search: string,
  method: string
): Promise<NextResponse> {
  const session = await getSession(id);
  if (!session) {
    return new NextResponse(
      `<!doctype html><html><body style="font-family:system-ui;background:#0b0f14;color:#e5e7eb;padding:40px"><h2>Replay session not found</h2><p>The replay session expired (24h TTL) or the server was restarted. Re-run the check in the console to create a fresh one.</p></body></html>`,
      { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
    );
  }

  const target = targetFromPath(pathSegs, search);
  if (!target) {
    return new NextResponse("Bad replay target", { status: 400 });
  }

  const maxRedirects = 4;
  let current = target;
  const chain: string[] = [];
  let status = 502;
  let html = "";
  let contentType = "text/html; charset=utf-8";
  let finalUrl = target;

  for (let i = 0; i <= maxRedirects; i++) {
    const cookieHeader = session.jar.headerFor(current);
    const res = await fetch(current, {
      method: method === "POST" ? "POST" : "GET",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);

    if (!res) {
      html = `<!doctype html><html><body style="font-family:system-ui;background:#0b0f14;color:#e5e7eb;padding:40px"><h2>Upstream fetch failed</h2><p>The target site could not be reached from the server (network or bot protection).</p></body></html>`;
      status = 502;
      break;
    }

    const setCookies = [...(res.headers.getSetCookie ? res.headers.getSetCookie() : [])];
    if (setCookies.length) session.jar.setFromResponse(current, setCookies);
    status = res.status;
    const loc = res.headers.get("location");

    if (loc && status >= 300 && status < 400) {
      try {
        const next = new URL(loc, current);
        chain.push(`${status} → ${next.href}`);
        current = next.href;
        finalUrl = next.href;
        continue;
      } catch {
        break;
      }
    }

    contentType = res.headers.get("content-type") || "text/html; charset=utf-8";
    finalUrl = current;
    if (/^text\/html|^application\/xhtml/i.test(contentType)) {
      html = await res.text().catch(() => "");
    } else {
      // non-HTML: stream raw bytes through
      const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
      const headers = new Headers({ "cache-control": "no-store" });
      if (contentType) headers.set("content-type", contentType);
      return new NextResponse(buf, { status, headers });
    }
    break;
  }

  if (chain.length && status >= 200 && status < 300) {
    // reached final content after redirects
  }

  if (/^text\/html/i.test(contentType) && html) {
    // inject <base href> so relative assets resolve against the real site
    const baseTag = `<base href="${current.replace(/"/g, "&quot;")}">`;
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
    } else if (/<html[^>]*>/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
    } else {
      html = baseTag + html;
    }
  }

  const headers = new Headers({ "cache-control": "no-store" });
  headers.set("content-type", contentType || "text/html; charset=utf-8");
  headers.set("x-replay-target", target);
  headers.set("x-replay-final", finalUrl);
  return new NextResponse(html, { status: status >= 300 && status < 400 ? 200 : status, headers });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; path?: string[] }> }) {
  const { id, path } = await ctx.params;
  const segs = (path || []).map((s) => s);
  const url = new URL(req.url);
  return proxy(id, segs, url.search, "GET");
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; path?: string[] }> }) {
  const { id, path } = await ctx.params;
  const segs = (path || []).map((s) => s);
  const url = new URL(req.url);
  return proxy(id, segs, url.search, "POST");
}
