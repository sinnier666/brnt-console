import { NextResponse } from "next/server";
import { cookiePairsFromSource } from "@/lib/cookies";
import { getSession } from "@/lib/session-store";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession(id);
  if (!session) {
    return NextResponse.json(
      { alive: false, cookies: null },
      { headers: { "cache-control": "no-store" } }
    );
  }
  return NextResponse.json(
    {
      alive: true,
      cookies: cookiePairsFromSource(session.jar.all()),
      // full jar (Cookie-Editor style) so consumers can rebuild httpOnly /
      // domain / expiry — used by the nftoken magic-link generator
      jar: session.jar.toJSON().cookies,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
