import { parseCookieText } from "@/lib/cookies";
import { kv } from "./storage";

// Usage audit log: every time a member APPLIES session data (opens a live page
// via nftoken, downloads cookies, mints an nftoken) the console appends one
// human-readable line to a per-day log ("logs/usage-<YYYY-MM-DD>.txt" in the
// KV store — .data/logs/ locally, Netlify Blobs on Netlify; dates bucketed in
// UTC+8, matching the console owner's timezone).
//
// Members can clear their OWN records; the admin downloads everything by date.

const LOG_PREFIX = "logs/usage-";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageEntry {
  at: string; // ISO timestamp
  member: string; // member key code (e.g. BRNT-XXXX-XXXX) or "admin"
  action: string; // nft-open | magic-open | cookies-download | nftoken-mint | cookies-copy | live-added | live-removed
  site: string; // target host
  cookieNames: string[];
  cookieHeader: string; // full header — the applied cookie material
}

/** YYYY-MM-DD in UTC+8 for an ISO timestamp. */
export function bucketDate(iso: string): string {
  const d = new Date(Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : Date.now());
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function keyFor(date: string): string {
  return `${LOG_PREFIX}${date}.txt`;
}

export function formatEntry(e: UsageEntry): string {
  const names = (e.cookieNames || []).join(", ");
  return `[${e.at}] member=${e.member} action=${e.action} site=${e.site || "-"} cookies=${
    (e.cookieNames || []).length
  } [${names}] | header: ${e.cookieHeader || "-"}`;
}

const LINE_RE =
  /^\[([^\]]+)\] member=(\S+) action=(\S+) site=(\S+) cookies=(\d+) \[([^\]]*)\] \| header: (.*)$/;

export function parseLine(line: string): UsageEntry | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return {
    at: m[1],
    member: m[2],
    action: m[3],
    site: m[4],
    cookieNames: m[6] ? m[6].split(",").map((s) => s.trim()).filter(Boolean) : [],
    cookieHeader: m[7] === "-" ? "" : m[7],
  };
}

function entryFromInput(input: Partial<UsageEntry>): UsageEntry {
  const header = String(input.cookieHeader || "");
  const cookies = parseCookieText(header).cookies;
  const names = cookies.length ? cookies.map((c) => c.name) : [];
  return {
    at: input.at && Number.isFinite(Date.parse(input.at)) ? input.at : new Date().toISOString(),
    member: String(input.member || "unknown").slice(0, 40),
    action: String(input.action || "unknown").slice(0, 40),
    site: String(input.site || "-").slice(0, 120),
    cookieNames: names.length ? names : input.cookieNames || [],
    cookieHeader: header,
  };
}

export async function appendUsage(input: Partial<UsageEntry>): Promise<UsageEntry> {
  const entry = entryFromInput(input);
  const key = keyFor(bucketDate(entry.at));
  const raw = (await kv.get(key)) || "";
  await kv.set(key, raw + formatEntry(entry) + "\n");
  return entry;
}

/** All dates that have a log, newest first, with line counts. */
export async function listUsageDates(): Promise<{ date: string; count: number }[]> {
  const keys = await kv.list(LOG_PREFIX);
  const out: { date: string; count: number }[] = [];
  for (const key of keys) {
    const m = /usage-(\d{4}-\d{2}-\d{2})\.txt$/.exec(key);
    if (!m) continue;
    const date = m[1];
    const raw = (await kv.get(key)) || "";
    const count = raw.split("\n").filter((l) => l.trim()).length;
    if (count > 0) out.push({ date, count });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function readUsageDate(date: string): Promise<string | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return kv.get(keyFor(date));
}

/** Structured entries across all dates (newest first). */
export async function readAllEntries(): Promise<UsageEntry[]> {
  const out: UsageEntry[] = [];
  for (const { date } of await listUsageDates()) {
    const raw = (await readUsageDate(date)) || "";
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const e = parseLine(line);
      if (e) out.push(e);
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

async function rewriteFile(date: string, lines: string[]): Promise<void> {
  if (!lines.length) {
    await kv.del(keyFor(date));
    return;
  }
  await kv.set(keyFor(date), lines.join("\n") + "\n");
}

/** Remove every record of one member (their "clear my activity" button). */
export async function clearMember(member: string): Promise<number> {
  let removed = 0;
  for (const { date } of await listUsageDates()) {
    const raw = (await readUsageDate(date)) || "";
    const kept: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const e = parseLine(line);
      if (e && e.member === member) {
        removed++;
      } else {
        kept.push(line);
      }
    }
    await rewriteFile(date, kept);
  }
  return removed;
}

/** Admin: clear one date, or everything. */
export async function clearUsage(date?: string): Promise<number> {
  let removed = 0;
  const dates = date ? [date] : (await listUsageDates()).map((d) => d.date);
  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const raw = (await readUsageDate(d)) || "";
    removed += raw.split("\n").filter((l) => l.trim()).length;
    await rewriteFile(d, []);
  }
  return removed;
}

/** Age helper used by cleanup flows (log files older than N days can be pruned). */
export function olderThan(date: string, days: number): boolean {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) && Date.now() - t > days * DAY_MS;
}
