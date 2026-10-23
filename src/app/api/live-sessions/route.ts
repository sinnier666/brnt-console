import { NextRequest, NextResponse } from "next/server";
import { isAdminKey, validateCode } from "@/lib/access";
import { addLiveSession, listLiveSessions, removeLiveSession } from "@/lib/live-sessions";

/**
 * GET    /api/live-sessions                — member/admin: list the live pool
 * POST   /api/live-sessions  (admin only)  — add { target?, cookies, label? }
 * DELETE /api/live-sessions?id=… (admin)   — remove one entry
 *
 * Admin auth: x-brnt-admin header (verified per request, never trusted client-side).
 */
export async function GET(req: NextRequest) {
  const member = await validateCode(req.headers.get("x-brnt-access"));
  const admin = isAdminKey(req.headers.get("x-brnt-admin") || "");
  if (!member && !admin) {
    return NextResponse.json(
      { ok: false, error: "ACCESS_REQUIRED", message: "A valid member access key is required." },
      { status: 403 }
    );
  }
  return NextResponse.json({ ok: true, sessions: await listLiveSessions() });
}

export async function POST(req: NextRequest) {
  if (!isAdminKey(req.headers.get("x-brnt-admin") || "")) {
    return NextResponse.json(
      { ok: false, error: "ADMIN_REQUIRED", message: "Only the admin can add live sessions." },
      { status: 403 }
    );
  }
  let body: {
    target?: string;
    cookies?: string;
    cookieObjs?: unknown;
    sessionId?: string;
    label?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }
  const res = await addLiveSession({
    target: String(body.target || ""),
    cookies: String(body.cookies || ""),
    cookieObjs: Array.isArray(body.cookieObjs) ? (body.cookieObjs as never[]) : undefined,
    sessionId: body.sessionId,
    label: String(body.label || ""),
  });
  if (!res.ok) return NextResponse.json(res, { status: 400 });
  return NextResponse.json(res);
}

export async function DELETE(req: NextRequest) {
  if (!isAdminKey(req.headers.get("x-brnt-admin") || "")) {
    return NextResponse.json(
      { ok: false, error: "ADMIN_REQUIRED", message: "Only the admin can remove live sessions." },
      { status: 403 }
    );
  }
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ ok: false, error: "ID_REQUIRED" }, { status: 400 });
  const removed = await removeLiveSession(id);
  if (!removed) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
