import { NextRequest, NextResponse } from "next/server";
import { isAdminKey, validateCode } from "@/lib/access";
import {
  appendUsage,
  clearMember,
  clearUsage,
  listUsageDates,
  readAllEntries,
  readUsageDate,
} from "@/lib/usage-log";

/**
 * GET  /api/usage-log?list=1          (admin) → [{ date, count }]
 * GET  /api/usage-log?date=YYYY-MM-DD (admin) → text/plain download of that day
 * GET  /api/usage-log?mine=1          (member)→ own records (newest first)
 * POST /api/usage-log                 (member)→ record an apply action
 *       body: { action, site?, cookieHeader? }
 * DELETE /api/usage-log               (member)→ clear OWN records
 * DELETE /api/usage-log?date=…|all=1  (admin) → clear one date / everything
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const member = await validateCode(req.headers.get("x-brnt-access"));
  const admin = isAdminKey(req.headers.get("x-brnt-admin") || "");

  if (sp.get("list")) {
    if (!admin) return NextResponse.json({ ok: false, error: "ADMIN_REQUIRED" }, { status: 403 });
    return NextResponse.json({ ok: true, dates: await listUsageDates() });
  }

  const date = sp.get("date");
  if (date) {
    if (!admin) return NextResponse.json({ ok: false, error: "ADMIN_REQUIRED" }, { status: 403 });
    const content = await readUsageDate(date);
    if (content === null) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    }
    return new NextResponse(content || "(empty — no records for this date)\n", {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="brnt-usage-${date}.txt"`,
        "cache-control": "no-store",
      },
    });
  }

  if (sp.get("mine")) {
    if (!member) return NextResponse.json({ ok: false, error: "ACCESS_REQUIRED" }, { status: 403 });
    const mine = (await readAllEntries()).filter((e) => e.member === member.code);
    return NextResponse.json({ ok: true, entries: mine.slice(0, 50), total: mine.length });
  }

  return NextResponse.json({ ok: false, error: "BAD_REQUEST", message: "Use ?list=1, ?date=… or ?mine=1" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const member = await validateCode(req.headers.get("x-brnt-access"));
  const admin = isAdminKey(req.headers.get("x-brnt-admin") || "");
  if (!member && !admin) {
    return NextResponse.json({ ok: false, error: "ACCESS_REQUIRED" }, { status: 403 });
  }
  let body: { action?: string; site?: string; cookieHeader?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }
  const entry = await appendUsage({
    member: member ? member.code : "admin",
    action: String(body.action || "unknown"),
    site: String(body.site || "-"),
    cookieHeader: String(body.cookieHeader || ""),
  });
  return NextResponse.json({ ok: true, entry: { at: entry.at, action: entry.action, site: entry.site } });
}

export async function DELETE(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const member = await validateCode(req.headers.get("x-brnt-access"));
  const admin = isAdminKey(req.headers.get("x-brnt-admin") || "");
  if (!member && !admin) {
    return NextResponse.json({ ok: false, error: "ACCESS_REQUIRED" }, { status: 403 });
  }

  // Admin date/all clear
  if (sp.get("all") || sp.get("date")) {
    if (!admin) return NextResponse.json({ ok: false, error: "ADMIN_REQUIRED" }, { status: 403 });
    const removed = await clearUsage(sp.get("date") || undefined);
    return NextResponse.json({ ok: true, removed });
  }

  // Member clear-own
  if (!member) return NextResponse.json({ ok: false, error: "ACCESS_REQUIRED" }, { status: 403 });
  const removed = await clearMember(member.code);
  return NextResponse.json({ ok: true, removed });
}
