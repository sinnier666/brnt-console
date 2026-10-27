import type { ProbeRequest, ProbeResult } from "@/lib/probe-types";
import { accessHeader, clearAccess } from "@/lib/access-client";

/** Server error class for checks blocked by the member-access gate. */
export const ACCESS_REQUIRED_CODE = "ACCESS_REQUIRED";

function errorRow(req: ProbeRequest, error: string, errorCode?: string): ProbeResult {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    target: req.url,
    username: req.username,
    password: req.password,
    verdict: "error",
    confidence: "low",
    evidence: [],
    httpStatus: null,
    finalUrl: req.url,
    redirected: false,
    cookiesSet: [],
    elapsedMs: 0,
    pageTitle: null,
    snippet: null,
    detection: null,
    baseline: null,
    checkedAt: new Date().toISOString(),
    error,
    errorCode: errorCode ?? null,
  };
}

/**
 * True when the row was blocked by the member-access gate (it never ran).
 * Also matches rows persisted before the errorCode field existed, so old
 * stored results get the same "stale lock" treatment in the UI.
 */
export function isAccessBlockedResult(r: ProbeResult): boolean {
  if (r.errorCode === ACCESS_REQUIRED_CODE) return true;
  return (
    !!r.error &&
    (r.error.startsWith("This console is locked") ||
      r.error.startsWith("Your member access key has expired"))
  );
}

/** Calls the server-side check API and normalizes transport errors into a result row. */
export async function callCheckApi(req: ProbeRequest): Promise<ProbeResult> {
  try {
    const res = await fetch("/api/check-login", {
      method: "POST",
      headers: { "content-type": "application/json", ...accessHeader() },
      body: JSON.stringify(req),
    });
    const data = (await res.json()) as ProbeResult & { error?: string; message?: string };
    if (!res.ok && !data.verdict) {
      if (res.status === 403 && data.error === "ACCESS_REQUIRED") {
        clearAccess(); // re-opens the lock screen via the access store
        return errorRow(
          req,
          data.message ?? "Member access required — unlock the console with your access key.",
          ACCESS_REQUIRED_CODE,
        );
      }
      return errorRow(req, data.error ?? `Request failed with HTTP ${res.status}.`);
    }
    return data;
  } catch (err) {
    return errorRow(
      req,
      err instanceof Error ? err.message : "Network error while calling the check API.",
    );
  }
}

/** Adds https:// to bare domains like `example.com/login` (leaves scheme'd URLs untouched). */
export function normalizeUrl(raw: string): string {
  const u = raw.trim();
  if (!u) return u;
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/**
 * Finds "separator" colons in a line, ignoring colons that belong to the URL:
 * - scheme colon (`https://…`) → followed by `//`
 * - port colon (`example.com:8080/…`) → immediately followed by digits
 * A colon counts as a separator when it is surrounded by whitespace
 * (`website : login`) or directly followed by a non-digit, non-slash char
 * (`login:user:pass` without spaces).
 */
function colonSeparators(line: string): number[] {
  const seps: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ":") continue;
    if (line.slice(i + 1, i + 3) === "//") continue; // scheme colon
    const prev = line[i - 1] ?? "";
    const next = line[i + 1] ?? "";
    const spaceSeparated = /\s/.test(prev) || /\s/.test(next);
    const looksLikePort = /\d/.test(next); // port digits come right after the colon
    const looksLikePath = next === "/";
    if (spaceSeparated || (next !== "" && !looksLikePort && !looksLikePath)) {
      seps.push(i);
    }
  }
  return seps;
}

export interface BulkRow {
  /** Target website taken from the line, or null when the line is only `login : password`. */
  url: string | null;
  username: string;
  password: string;
  /** True for website-only lines checked with the shared session cookies (no credentials). */
  cookieOnly?: boolean;
}

/** True when a token clearly identifies a website rather than a username. */
export function looksLikeUrlToken(t: string): boolean {
  const s = t.trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (s.includes("@")) return false; // emails are usernames, not sites
  if (s.includes("/")) return true; // has a path → almost certainly a URL
  // bare domain (example.com) or host:port (localhost:3000)
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(s) || /^[a-z0-9.-]+:\d{2,5}$/i.test(s);
}

/**
 * Effective target URL for a parsed bulk row.
 * Priority: locked shared URL → the row's own URL → shared URL → null (row cannot run).
 */
export function resolveRowUrl(row: BulkRow, sharedUrl: string, locked: boolean): string | null {
  const shared = normalizeUrl(sharedUrl.trim());
  if (locked && shared) return shared;
  if (row.url) return row.url;
  return shared || null;
}

/**
 * Parses one bulk line into { url, username, password }.
 * Accepted formats (auto-detected, spaces around separators optional):
 *   url, username, password        (comma)
 *   url | username | password      (pipe)
 *   url<TAB>username<TAB>password  (tab)
 *   url: username : password       (colon — e.g. `website: login : password`)
 *   username : password            (two fields → url is null; pair with a shared login URL)
 *   url username                   (two fields, first looks like a URL → empty password)
 *   # comment lines are ignored
 * URLs keep their own colons (https://, :8080); bare domains get https:// added.
 * When opts.hasSharedUrl is true the data is declared to be user/password-only:
 * two-field lines are read as `username : password` (unless the first field is an
 * explicit http(s):// URL or contains a path), and 3-field lines whose first
 * field is not URL-like are read as `username : rest` too.
 * When opts.hasSharedCookies is true, a line that is only a website URL becomes
 * a cookie-session row (cookieOnly: true, no username/password) — it is checked
 * against the shared cookies instead of credentials.
 * The password is everything after the last needed separator, so it may contain
 * that separator character in later positions.
 */
export function parseBulkLine(
  line: string,
  opts?: { hasSharedUrl?: boolean; hasSharedCookies?: boolean },
): BulkRow | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const hasSharedUrl = opts?.hasSharedUrl ?? false;

  const commaCount = (trimmed.match(/[|\t,]/g) ?? []).length;
  const seps = colonSeparators(trimmed);

  // username + password: split at the first separator of any kind; the password keeps the rest
  const asUserPass = (): BulkRow | null => {
    const m = trimmed.match(/^(.*?)\s*[:|,\t]\s*([\s\S]*)$/);
    if (!m || !m[1].trim()) return null;
    return { url: null, username: m[1].trim(), password: m[2].trim() };
  };

  // two fields: decide between `website + login` (empty password) and `login + password`
  const twoField = (first: string, second: string): BulkRow | null => {
    first = first.trim();
    second = second.trim();
    if (!first) return null;
    const explicitUrl =
      looksLikeUrlToken(first) &&
      (!hasSharedUrl || /^https?:\/\//i.test(first) || first.includes("/"));
    if (explicitUrl) return { url: normalizeUrl(first), username: second, password: "" };
    if (!second) return null; // one bare token with no website and no password is unusable
    return { url: null, username: first, password: second };
  };

  // 1) comma / pipe / tab separated — url, username, password
  if (commaCount >= 2) {
    const m = trimmed.match(/^(.*?)\s*[|\t,]\s*(.*?)\s*[|\t,]\s*([\s\S]*)$/);
    if (m && m[1] && m[2]) {
      if (hasSharedUrl && !looksLikeUrlToken(m[1])) return asUserPass();
      return { url: normalizeUrl(m[1]), username: m[2].trim(), password: (m[3] ?? "").trim() };
    }
  }

  // 2) colon separated: `website: login : password`
  if (seps.length >= 2) {
    const url = trimmed.slice(0, seps[0]).trim();
    const username = trimmed.slice(seps[0] + 1, seps[1]).trim();
    const password = trimmed.slice(seps[1] + 1).trim();
    if (hasSharedUrl && !looksLikeUrlToken(url)) return asUserPass();
    if (url && username) return { url: normalizeUrl(url), username, password };
  }

  // 3) two-field lines
  if (commaCount === 1) {
    const idx = trimmed.search(/[|\t,]/);
    const r = twoField(trimmed.slice(0, idx), trimmed.slice(idx + 1));
    if (r) return r;
  }
  if (seps.length === 1) {
    const r = twoField(trimmed.slice(0, seps[0]), trimmed.slice(seps[0] + 1));
    if (r) return r;
  }

  // 4) a lone website URL with no credentials → cookie-session row (needs shared cookies)
  if (opts?.hasSharedCookies && looksLikeUrlToken(trimmed)) {
    return { url: normalizeUrl(trimmed), username: "", password: "", cookieOnly: true };
  }

  return null;
}
