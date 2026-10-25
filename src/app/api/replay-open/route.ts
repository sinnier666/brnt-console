import { NextRequest, NextResponse } from "next/server";
import { validateCode } from "@/lib/access";
import { CookieJar, parseCookieText, type ParsedCookie } from "@/lib/cookies";
import { createSession } from "@/lib/session-store";
import { normalizeProbeUrl } from "@/lib/login-probe";
import { appendUsage } from "@/lib/usage-log";

/**
 * POST /api/replay-open — create a server-side replay session from a cookie
 * set and return its proxy URL. This is what makes non-Netflix sites (Prime
 * Video etc.) open logged-in in ANY browser with NO Cookie Bridge extension:
 * the console itself fetches the site with the session cookies and serves the
 * page. Same trust level as /api/check-login (member-gated).
 *
 * Body: { target: string; cookies?: string; jar?: ParsedCookie[] } (jar wins)
 * Returns: { ok: true, id, url: "/api/replay/<id>/<scheme>/<host>/..." }
 * Sessions live 24h (KV-backed, survive restarts — see session-store.ts).
 */
export async function POST(req: NextRequest) {
  // member access gate (same as /api/check-login and /api/nftoken)
  const accessKey = req.headers.get("x-brnt-access");
  const record = await validateCode(accessKey);
  if (!record) {
    return NextResponse.json(
      { error: "ACCESS_REQUIRED", message: "A valid member access key is required." },
      { status: 403 }
    );
  }

  let body: { target?: string; cookies?: string; jar?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const rawTarget = String(body.target || "").trim();
  if (!rawTarget) {
    return NextResponse.json({ error: "URL_REQUIRED", message: "Target URL is required." }, { status: 400 });
  }
  let target: string;
  try {
    target = normalizeProbeUrl(rawTarget);
  } catch (e) {
    return NextResponse.json({ error: "BAD_URL", message: String(e) }, { status: 400 });
  }

  const jar: ParsedCookie[] = Array.isArray(body.jar)
    ? (body.jar as ParsedCookie[])
    : parseCookieText(String(body.cookies || "")).cookies;
  if (!jar.length) {
    return NextResponse.json(
      { error: "NO_COOKIES", message: "No cookies recognised for this session." },
      { status: 422 }
    );
  }

  const cj = new CookieJar();
  const host = (() => {
    try {
      return new URL(target).hostname;
    } catch {
      return "";
    }
  })();
  cj.seedParsed(jar, host);

  const session = await createSession(target, cj);

  // Audit trail, same pattern as the nftoken mint.
  appendUsage({
    member: record.code,
    action: "replay-open",
    site: host,
    cookieNames: jar.map((c) => c.name),
    cookieHeader: jar.map((c) => `${c.name}=${c.value}`).join("; "),
  });

  const u = new URL(target);
  const proxyPath = `/api/replay/${session.id}/${u.protocol.replace(":", "")}/${u.host}${u.pathname === "/" ? "/" : u.pathname}`;
  return NextResponse.json({ ok: true, id: session.id, url: proxyPath });
}
