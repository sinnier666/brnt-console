import { NextRequest, NextResponse } from "next/server";
import { validateCode } from "@/lib/access";
import { normalizeProbeUrl, probeWithCookies, probeWithCreds } from "@/lib/login-probe";

export async function POST(req: NextRequest) {
  // member access gate
  const accessKey = req.headers.get("x-brnt-access");
  const record = await validateCode(accessKey);
  if (!record) {
    return NextResponse.json(
      { error: "ACCESS_REQUIRED", message: "A valid member access key is required." },
      { status: 403 }
    );
  }

  let body: { url?: string; username?: string; password?: string; cookies?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const url = String(body.url || "").trim();
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const cookies = String(body.cookies || "");

  if (!url) {
    return NextResponse.json({ error: "URL_REQUIRED", message: "Target URL is required." }, { status: 400 });
  }

  let target: string;
  try {
    target = normalizeProbeUrl(url);
  } catch (e) {
    return NextResponse.json({ error: "BAD_URL", message: String(e) }, { status: 400 });
  }

  try {
    const result =
      cookies.trim() && (!username || !password)
        ? await probeWithCookies(target, cookies)
        : await probeWithCreds(target, username || "(blank)", password, cookies || undefined);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: "PROBE_FAILED", message: String(e && e.message ? e.message : e) },
      { status: 500 }
    );
  }
}
