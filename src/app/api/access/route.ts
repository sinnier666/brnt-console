import { NextRequest, NextResponse } from "next/server";
import { isAdminKey, mintKey, validateCode } from "@/lib/access";

export async function POST(req: NextRequest) {
  let body: { action?: string; adminKey?: string; days?: number; note?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }

  const action = String(body.action || "validate");

  if (action === "generate") {
    const res = await mintKey(String(body.adminKey || ""), Number(body.days) || 1, String(body.note || ""));
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: res.error }, { status: 403 });
    }
    return NextResponse.json({ ok: true, record: res.record });
  }

  if (action === "admin-verify") {
    // Used by the console to unlock admin-only UI (live panel management, logs).
    // The key itself is never stored client-side beyond this session storage.
    if (!isAdminKey(String(body.adminKey || ""))) {
      return NextResponse.json({ ok: false, error: "INVALID_ADMIN_KEY" }, { status: 403 });
    }
    return NextResponse.json({ ok: true, admin: true });
  }

  // default: validate
  const rec = await validateCode(String(body.code || ""));
  if (!rec) {
    return NextResponse.json({ ok: false, error: "INVALID_OR_EXPIRED" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, record: rec });
}
