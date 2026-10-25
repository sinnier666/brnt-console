import { NextRequest, NextResponse } from "next/server";
import { validateCode } from "@/lib/access";
import { getSession } from "@/lib/session-store";
import {
  crunchyrollTvActivate,
  crunchyrollTvInfo,
  netflixTvActivate,
  type TvResult,
} from "@/lib/tv-activate";
import { appendUsage } from "@/lib/usage-log";

/**
 * POST /api/tv-activate — TV device login using a stored probe session jar.
 * Gated by x-brnt-access (same as /api/check-login and /api/nftoken).
 *
 * Body: {
 *   sessionId: string        — probe session id whose jar holds the site cookies
 *   site: "crunchyroll" | "netflix"
 *   action: "info" | "activate"   (info = crunchyroll account snapshot only)
 *   code?: string            — the code shown on the TV (required for activate)
 * }
 */
export async function POST(req: NextRequest) {
  const accessKey = req.headers.get("x-brnt-access");
  const record = await validateCode(accessKey);
  if (!record) {
    return NextResponse.json(
      { error: "ACCESS_REQUIRED", message: "A valid member access key is required." },
      { status: 403 }
    );
  }

  let body: { sessionId?: string; site?: string; action?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const sessionId = String(body.sessionId || "").trim();
  const site = String(body.site || "").toLowerCase();
  const action = String(body.action || "activate").toLowerCase();
  const code = String(body.code || "");

  if (!sessionId) {
    return NextResponse.json(
      { ok: false, error: "NO_SESSION", message: "Run a check that captures a session first." },
      { status: 422 }
    );
  }
  if (site !== "crunchyroll" && site !== "netflix") {
    return NextResponse.json({ ok: false, error: "BAD_SITE", message: "Unsupported site." }, { status: 400 });
  }
  if (action !== "info" && action !== "activate") {
    return NextResponse.json({ ok: false, error: "BAD_ACTION" }, { status: 400 });
  }

  const session = await getSession(sessionId);
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "SESSION_GONE", message: "Session expired — re-run the check to refresh it." },
      { status: 404 }
    );
  }

  const jar = session.jar.toJSON().cookies;

  let result: TvResult;
  if (site === "crunchyroll" && action === "info") {
    try {
      const info = await crunchyrollTvInfo(jar);
      result = { ok: true, message: "info", info };
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  } else if (site === "crunchyroll") {
    result = await crunchyrollTvActivate(jar, code);
  } else {
    if (action === "info") {
      return NextResponse.json(
        { ok: false, error: "NO_INFO", message: "Account info is Crunchyroll-only; Netflix just needs the code." },
        { status: 400 }
      );
    }
    result = await netflixTvActivate(jar, code);
  }

  // Audit every activation attempt to the member's usage log (.txt by date).
  appendUsage({
    member: record.code,
    action: result.ok ? "tv-activate" : "tv-activate-failed",
    site: site === "netflix" ? "netflix.com/tv8" : "crunchyroll.com/activate",
    cookieHeader: jar.map((c) => `${c.name}=${c.value}`).join("; "),
  }).catch(() => {});

  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
