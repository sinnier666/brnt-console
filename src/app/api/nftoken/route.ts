import { NextRequest, NextResponse } from "next/server";
import { validateCode } from "@/lib/access";
import { extractNetflixAuth, mintNativeNftoken } from "@/lib/nftoken";
import { parseCookieText, type ParsedCookie } from "@/lib/cookies";
import { appendUsage } from "@/lib/usage-log";

/**
 * POST /api/nftoken  — mint a NATIVE Netflix login link (?nftoken=…) from
 * Netflix session cookies (NetflixId required). Gated by x-brnt-access.
 *
 * Body: { cookies?: string; jar?: ParsedCookie[] }  (jar wins when present)
 */
export async function POST(req: NextRequest) {
  // member access gate (same as /api/check-login)
  const accessKey = req.headers.get("x-brnt-access");
  const record = await validateCode(accessKey);
  if (!record) {
    return NextResponse.json(
      { error: "ACCESS_REQUIRED", message: "A valid member access key is required." },
      { status: 403 }
    );
  }

  let body: { cookies?: string; jar?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  let source: string | ParsedCookie[];
  if (Array.isArray(body.jar)) {
    source = body.jar as ParsedCookie[];
  } else {
    source = String(body.cookies || "");
  }

  const auth = extractNetflixAuth(source);
  if (!auth) {
    return NextResponse.json(
      {
        ok: false,
        error: "NO_NETFLIXID",
        message:
          "No NetflixId cookie found. Export the full netflix.com cookie set (must include NetflixId) and try again.",
      },
      { status: 422 }
    );
  }

  try {
    const minted = await mintNativeNftoken(auth);
    // Audit: every mint is recorded to the member's usage log (.txt by date).
    const jar: ParsedCookie[] = Array.isArray(body.jar)
      ? (body.jar as ParsedCookie[])
      : parseCookieText(String(body.cookies || "")).cookies;
    appendUsage({
      member: record.code,
      action: "nftoken-mint",
      site: "netflix.com",
      cookieHeader: jar.map((c) => `${c.name}=${c.value}`).join("; "),
    }).catch(() => {});
    return NextResponse.json({ ok: true, ...minted });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "MINT_FAILED",
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 502 }
    );
  }
}
