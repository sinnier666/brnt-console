import { NextResponse } from "next/server";
import { getSession } from "@/lib/session-store";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json(
    { alive: (await getSession(id)) !== null },
    { headers: { "cache-control": "no-store" } }
  );
}
