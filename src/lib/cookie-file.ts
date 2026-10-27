/**
 * Client-side cookies-export detection for bulk uploads.
 *
 * When a user drops a cookies.txt / JSON export into the bulk form (or picks a
 * whole folder of them), the file must be treated as ONE session check — never
 * line-split like a credential list. Splitting a Netscape cookies.txt used to
 * turn every tab-separated cookie line into a garbage `url|login|password` row.
 *
 * This module answers two questions about a file's text content:
 *   1. Is this a cookies export (vs. a credential list)?
 *   2. Which site do the cookies belong to (derived from their domains)?
 *
 * Kept dependency-free so it can be imported from client components —
 * the full engine in login-probe.ts stays server-side.
 */

const COOKIE_NAME_RE = /^[^\s=;,]+$/;

export interface CookieFileAnalysis {
  /** True when the content is a cookies export (Netscape, JSON or Cookie header). */
  isCookieFile: boolean;
  /** Best-effort site origin derived from the cookie domains (https://…), or null. */
  siteUrl: string | null;
  /** Number of parseable name/value cookies found. */
  pairCount: number;
}

/** Maps a cookie domain (`.primevideo.com`, `accounts.google.com`) to a site origin. */
export function cookieDomainToSiteUrl(domain: string): string | null {
  const raw = (domain ?? "").trim().toLowerCase();
  if (!raw) return null;
  const wasDot = raw.startsWith(".");
  const host = raw.replace(/^\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..")) return null;
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2 && host !== "localhost") return null;
  // A dot-domain (`.primevideo.com`) is site-wide; the www host is its canonical front door.
  const finalHost = wasDot && labels.length === 2 ? `www.${host}` : host;
  return `https://${finalHost}`;
}

function mostCommonDomain(domains: string[]): string | null {
  const counts = new Map<string, number>();
  for (const d of domains) {
    const key = d.trim().toLowerCase();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [key, n] of counts) {
    if (n > bestN) {
      best = key;
      bestN = n;
    }
  }
  return best;
}

/* ---------------- Netscape cookies.txt ---------------- */

function isNetscapeLine(line: string): boolean {
  const body = line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line;
  if (body.startsWith("#")) return false;
  return body.split("\t").length >= 7;
}

function analyzeNetscape(text: string): CookieFileAnalysis {
  const domains: string[] = [];
  let pairCount = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || !isNetscapeLine(line)) continue;
    const body = line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line;
    const f = body.split("\t");
    domains.push(f[0]);
    if (f[5]?.trim() && COOKIE_NAME_RE.test(f[5].trim())) pairCount++;
  }
  return {
    isCookieFile: pairCount > 0,
    siteUrl: mostCommonDomain(domains) ? cookieDomainToSiteUrl(mostCommonDomain(domains) as string) : null,
    pairCount,
  };
}

/* ---------------- JSON exports ---------------- */

function analyzeJson(parsed: unknown): CookieFileAnalysis | null {
  const domains: string[] = [];
  let pairCount = 0;

  const countObject = (o: Record<string, unknown>): boolean => {
    const name = typeof o.name === "string" ? o.name : typeof o.key === "string" ? (o.key as string) : "";
    const value = o.value;
    if (name && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      pairCount++;
      if (typeof o.domain === "string") domains.push(o.domain);
      return true;
    }
    return false;
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === "object" && !Array.isArray(item)) countObject(item as Record<string, unknown>);
    }
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const singleName = typeof obj.name === "string" ? obj.name : typeof obj.key === "string" ? (obj.key as string) : "";
    if (singleName && "value" in obj) {
      countObject(obj);
    } else {
      // Plain {cookieName: value} map
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          if (COOKIE_NAME_RE.test(k.trim())) pairCount++;
        }
      }
    }
  } else {
    return null;
  }

  if (pairCount === 0) return null;
  const top = mostCommonDomain(domains);
  return { isCookieFile: true, siteUrl: top ? cookieDomainToSiteUrl(top) : null, pairCount };
}

/* ---------------- Cookie header string ---------------- */

function looksLikeCredentialList(text: string): boolean {
  // Credential separators: tabs, pipes, commas used as field separators, or spaced colons
  // (`website : login : password`). Cookie headers contain none of those.
  return /\t/.test(text) || /[|,]\s*\S/.test(text) || /:\s|\s:/.test(text);
}

function analyzeHeader(text: string): CookieFileAnalysis {
  const stripped = text.replace(/^\s*cookie\s*:\s*/i, "").trim();
  const fragments = stripped
    .replace(/[\r\n]+/g, "; ")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  let pairCount = 0;
  for (const f of fragments) {
    const eq = f.indexOf("=");
    if (eq <= 0) continue;
    const name = f.slice(0, eq).trim();
    const value = f.slice(eq + 1).trim();
    if (!COOKIE_NAME_RE.test(name) || !value || /\s/.test(value)) continue;
    pairCount++;
  }

  const credentialish = looksLikeCredentialList(stripped);
  const singleBarePair =
    pairCount === 1 && fragments.length === 1 && !/[\t|,]/.test(stripped) && !stripped.includes(":");
  const isCookieFile = !credentialish && (pairCount >= 2 || singleBarePair);
  return { isCookieFile, siteUrl: null, pairCount: isCookieFile ? pairCount : 0 };
}

/**
 * Detects whether file content is a cookies export and which site it belongs to.
 * Order matters: Netscape (tab structure) → JSON (parseable) → Cookie header.
 * Anything else is treated as a credential list and parsed line-by-line.
 */
export function analyzeCookieFile(content: string): CookieFileAnalysis {
  const text = (content ?? "").trim();
  if (!text) return { isCookieFile: false, siteUrl: null, pairCount: 0 };

  // 1) Netscape cookies.txt — unambiguous tab structure, checked before JSON/none
  if (text.split(/\r?\n/).some((l) => l.trim() && isNetscapeLine(l))) {
    return analyzeNetscape(text);
  }

  // 2) JSON — array of cookie objects, single {name,value} object or {name: value} map.
  //    JSON credential lists (arrays of arrays / objects without name+value) are rejected.
  if (text.startsWith("{") || text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const res = analyzeJson(parsed);
      if (res) return res;
      return { isCookieFile: false, siteUrl: null, pairCount: 0 };
    }
    // JSONL fallback: one cookie object per line
    const domains: string[] = [];
    let pairCount = 0;
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        const name = typeof o.name === "string" ? o.name : typeof o.key === "string" ? (o.key as string) : "";
        const value = o.value;
        if (name && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
          pairCount++;
          if (typeof o.domain === "string") domains.push(o.domain);
        }
      } catch {
        /* not JSONL — ignore line */
      }
    }
    if (pairCount > 0) {
      const top = mostCommonDomain(domains);
      return { isCookieFile: true, siteUrl: top ? cookieDomainToSiteUrl(top) : null, pairCount };
    }
    return { isCookieFile: false, siteUrl: null, pairCount: 0 };
  }

  // 3) Cookie header string — requires ≥2 `name=value` pairs (or one bare pair)
  return analyzeHeader(text);
}

/* ---------------- Cookies-used display ---------------- */

export interface CookiePair {
  name: string;
  value: string;
}

/* ---------------- Export builders (open-original-site handoff) --------- */

const YEAR_SECONDS = 60 * 60 * 24 * 365;

function targetHostInfo(targetUrl: string): { host: string; secure: boolean } {
  try {
    const u = new URL(targetUrl);
    return { host: u.hostname, secure: u.protocol === "https:" };
  } catch {
    return { host: "", secure: true };
  }
}

/** Joins pairs back into a Cookie header — the format every cookie editor
 *  accepts for a quick paste-import (`sid=abc; csrf=xyz`). */
export function cookieHeaderFromPairs(pairs: CookiePair[]): string {
  return pairs.map((p) => `${p.name}=${p.value}`).join("; ");
}

/**
 * Cookie-Editor / EditThisCookie import format for the row's target site.
 * Cookies get a 1-year expiry so an import STAYS logged in ("permanently",
 * as far as the site's own session lifetime allows).
 */
export function cookieEditorExport(pairs: CookiePair[], targetUrl: string): string {
  const { host, secure } = targetHostInfo(targetUrl);
  const exp = Math.floor(Date.now() / 1000) + YEAR_SECONDS;
  return JSON.stringify(
    pairs.map((p) => ({
      name: p.name,
      value: p.value,
      domain: host,
      hostOnly: true,
      path: "/",
      secure,
      httpOnly: false,
      sameSite: secure ? "no_restriction" : "lax",
      session: false,
      expirationDate: exp,
    })),
    null,
    2,
  );
}

/** Netscape cookies.txt export for the row's target site (same 1-year expiry). */
export function netscapeExport(pairs: CookiePair[], targetUrl: string): string {
  const { host, secure } = targetHostInfo(targetUrl);
  const exp = Math.floor(Date.now() / 1000) + YEAR_SECONDS;
  const lines = pairs.map(
    (p) =>
      [host || "localhost", "FALSE", "/", secure ? "TRUE" : "FALSE", String(exp), p.name, p.value].join("\t"),
  );
  return ["# Netscape HTTP Cookie File", "# Exported by BRNT LoginProbe", ...lines].join("\n");
}

/**
 * Extracts the name=value pairs from a raw cookie source (any of the three
 * accepted formats) so the UI can SHOW which cookies a check used. Duplicates
 * keep their first occurrence — same as the server-side jar behaviour.
 */
export function cookiePairsFromSource(content: string): CookiePair[] {
  const text = (content ?? "").trim();
  if (!text) return [];
  const pairs: CookiePair[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: string) => {
    name = name.trim();
    value = value.trim();
    if (!name || !COOKIE_NAME_RE.test(name) || seen.has(name)) return;
    seen.add(name);
    pairs.push({ name, value });
  };

  const lines = text.split(/\r?\n/);

  // 1) Netscape cookies.txt — columns: domain \t flag \t path \t secure \t expiry \t name \t value
  let netscape = 0;
  for (const line of lines) {
    if (!line.trim() || !isNetscapeLine(line)) continue;
    const body = line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line;
    const f = body.split("\t");
    if (f.length >= 7) {
      push(f[5], f[6] ?? "");
      netscape++;
    }
  }
  if (netscape > 0) return pairs;

  // 2) JSON object(s)
  if (text.startsWith("{") || text.startsWith("[")) {
    const collect = (o: Record<string, unknown>) => {
      const name = typeof o.name === "string" ? o.name : typeof o.key === "string" ? (o.key as string) : "";
      const v = o.value;
      if (name && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
        push(name, String(v));
      }
    };
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object" && !Array.isArray(item)) collect(item as Record<string, unknown>);
        }
      } else if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const singleName = typeof obj.name === "string" || typeof obj.key === "string";
        if (singleName && "value" in obj) collect(obj);
        else for (const [k, v] of Object.entries(obj)) if (typeof v !== "object") push(k, String(v));
      }
    } catch {
      // JSONL fallback: one cookie object per line
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          collect(JSON.parse(t) as Record<string, unknown>);
        } catch {
          /* not JSON — skip line */
        }
      }
    }
    if (pairs.length > 0) return pairs;
  }

  // 3) Cookie header string
  const stripped = text.replace(/^\s*cookie\s*:\s*/i, "").replace(/[\r\n]+/g, "; ");
  for (const frag of stripped.split(";")) {
    const eq = frag.indexOf("=");
    if (eq <= 0) continue;
    push(frag.slice(0, eq), frag.slice(eq + 1));
  }
  return pairs;
}
