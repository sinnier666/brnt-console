/**
 * Automated cookie import — the bridge between this web app and the BRNT
 * Cookie Importer browser extension.
 *
 * Browsers forbid a web page from planting another site's cookies — that is
 * why clicking a target could never log you in on the REAL url directly. The
 * companion extension has the privileged `cookies` API and CAN. This module:
 *
 *   1. turns any cookie source (Netscape cookies.txt / Cookie-Editor JSON /
 *      header string) into structured cookies the extension understands,
 *      preserving domain/path/secure/httpOnly/expiry whenever the source has
 *      them (Netscape + JSON do — a full-fidelity import beats name=value),
 *   2. speaks the little postMessage handshake the extension's content script
 *      listens for on this app's origin:
 *
 *        page    → { namespace, type:"BRNT_EXTENSION_PING" }
 *        ext     → { namespace, type:"BRNT_EXTENSION_HERE" }
 *        page    → { namespace, type:"BRNT_APPLY_COOKIES", requestId, url?, cookies }
 *        ext     → { namespace, type:"BRNT_APPLY_COOKIES_RESULT", requestId, ok, applied, errors? }
 *
 * postApplyCookies resolves `null` when nothing answered (extension not
 * installed) so callers can fall back to the copy / Cookie-Editor flow.
 *
 * Client-safe (the React hook below is only ever imported from "use client"
 * components) and dependency-free otherwise.
 */

import { useEffect, useState } from "react";

export const EXT_NAMESPACE = "brnt-cookie-import";

const YEAR_SECONDS = 60 * 60 * 24 * 365;
const COOKIE_NAME_RE = /^[^\s=;,]+$/;

export interface ApplyCookie {
  name: string;
  value: string;
  /** Cookie domain (`site.com` or `.site.com`). Omitted → host-only on the target. */
  domain?: string;
  /** True when the cookie must match the exact host only (no subdomains). */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "no_restriction" | "lax" | "strict" | "unspecified";
  /** Unix seconds — omit for session cookies. */
  expirationDate?: number;
  session: boolean;
}

export interface ApplyPayload {
  namespace: typeof EXT_NAMESPACE;
  url?: string;
  cookies: ApplyCookie[];
}

export interface ApplyAck {
  ok: boolean;
  applied: number;
  errors: string[];
}

function targetInfo(targetUrl: string): { host: string; secure: boolean } {
  try {
    const u = new URL(targetUrl);
    return { host: u.hostname, secure: u.protocol === "https:" };
  } catch {
    return { host: "", secure: true };
  }
}

/** Chrome refuses SameSite=None without Secure — downgrade instead of failing. */
function normalizeSameSite(v: unknown, secure: boolean): ApplyCookie["sameSite"] {
  const s = typeof v === "string" ? v.toLowerCase().replace(/-/g, "_") : "";
  if (s === "no_restriction" || s === "none") return secure ? "no_restriction" : "lax";
  if (s === "lax") return "lax";
  if (s === "strict") return "strict";
  return "unspecified";
}

/* ---------------- source parsers ---------------- */

function isNetscapeLine(line: string): boolean {
  const body = line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line;
  if (body.startsWith("#")) return false;
  return body.split("\t").length >= 7;
}

/** Netscape line → structured cookie (full fidelity: domain/path/secure/expiry/httpOnly). */
function fromNetscapeLine(line: string): ApplyCookie | null {
  const httpOnly = line.startsWith("#HttpOnly_");
  const body = httpOnly ? line.slice("#HttpOnly_".length) : line;
  const f = body.split("\t");
  if (f.length < 7) return null;
  const name = f[5]?.trim();
  if (!name || !COOKIE_NAME_RE.test(name)) return null;
  const rawDomain = f[0]?.trim() ?? "";
  const includeSub = (f[1] ?? "").toUpperCase() === "TRUE";
  const secure = (f[3] ?? "").toUpperCase() === "TRUE";
  const exp = Number.parseInt(f[4] ?? "0", 10);
  return {
    name,
    value: f[6] ?? "",
    domain: rawDomain || undefined,
    hostOnly: !includeSub || !rawDomain,
    path: f[2]?.trim() || "/",
    secure,
    httpOnly,
    sameSite: normalizeSameSite("unspecified", secure),
    ...(Number.isFinite(exp) && exp > 0 ? { expirationDate: exp } : {}),
    session: !(Number.isFinite(exp) && exp > 0),
  };
}

/** Cookie-Editor / EditThisCookie style object → structured cookie. */
function fromJsonObject(o: Record<string, unknown>, fallbackHost: string, fallbackSecure: boolean): ApplyCookie | null {
  const name = typeof o.name === "string" ? o.name : typeof o.key === "string" ? (o.key as string) : "";
  const v = o.value;
  if (!name || !COOKIE_NAME_RE.test(name) || (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")) {
    return null;
  }
  const domain = typeof o.domain === "string" && o.domain.trim() ? o.domain.trim() : fallbackHost;
  const secure = typeof o.secure === "boolean" ? o.secure : fallbackSecure;
  const httpOnly = o.httpOnly === true;
  const session = o.session === true || o.expirationDate == null;
  const exp = typeof o.expirationDate === "number" ? o.expirationDate : undefined;
  const hostOnly = o.hostOnly === true || !domain.startsWith(".");
  return {
    name,
    value: String(v),
    domain: domain || undefined,
    hostOnly,
    path: typeof o.path === "string" && o.path ? o.path : "/",
    secure,
    httpOnly,
    sameSite: normalizeSameSite(o.sameSite, secure),
    ...(session || !exp ? {} : { expirationDate: exp }),
    session,
  };
}

/** Header-string fragment (`k=v`) → host-only cookie on the target. */
function fromHeaderPair(frag: string, host: string, secure: boolean): ApplyCookie | null {
  const eq = frag.indexOf("=");
  if (eq <= 0) return null;
  const name = frag.slice(0, eq).trim();
  const value = frag.slice(eq + 1).trim();
  if (!name || !COOKIE_NAME_RE.test(name)) return null;
  return {
    name,
    value,
    domain: host || undefined,
    hostOnly: true,
    path: "/",
    secure,
    httpOnly: false,
    sameSite: normalizeSameSite(secure ? "none" : "lax", secure),
    expirationDate: Math.floor(Date.now() / 1000) + YEAR_SECONDS,
    session: false,
  };
}

/**
 * Parses ANY accepted cookie source into structured cookies for the extension.
 * `targetUrl` supplies the host/secure defaults when the source has none
 * (header strings, JSON {name:value} maps). Falls back to header parsing for
 * anything it cannot recognise, so a jar header from the server works too.
 */
export function parseSourceCookies(source: string, targetUrl: string): ApplyCookie[] {
  const text = (source ?? "").trim();
  const { host, secure } = targetInfo(targetUrl);
  if (!text) return [];

  const lines = text.split(/\r?\n/);

  // 1) Netscape cookies.txt — unambiguous tab structure
  const netscape: ApplyCookie[] = [];
  for (const line of lines) {
    if (!line.trim() || !isNetscapeLine(line)) continue;
    const c = fromNetscapeLine(line);
    if (c) netscape.push(c);
  }
  if (netscape.length > 0) return netscape;

  // 2) JSON (array / single object / name:value map / JSONL)
  if (text.startsWith("{") || text.startsWith("[")) {
    const out: ApplyCookie[] = [];
    const collect = (o: Record<string, unknown>) => {
      const c = fromJsonObject(o, host, secure);
      if (c) out.push(c);
    };
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object" && !Array.isArray(item)) collect(item as Record<string, unknown>);
        }
      } else if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const single = typeof obj.name === "string" || typeof obj.key === "string";
        if (single && "value" in obj) collect(obj);
        else {
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v !== "object") collect({ name: k, value: v as unknown });
          }
        }
      }
    } catch {
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          collect(JSON.parse(t) as Record<string, unknown>);
        } catch {
          /* not JSONL — skip */
        }
      }
    }
    if (out.length > 0) return out;
  }

  // 3) Cookie header string (`k=v; k2=v2`, optional "Cookie:" prefix)
  const stripped = text.replace(/^\s*cookie\s*:\s*/i, "").replace(/[\r\n]+/g, "; ");
  const out: ApplyCookie[] = [];
  for (const frag of stripped.split(";")) {
    const c = fromHeaderPair(frag, host, secure);
    if (c) out.push(c);
  }
  return out;
}

/** Builds the postMessage payload the extension's content script relays. */
export function buildApplyPayload(cookies: ApplyCookie[], url?: string): ApplyPayload {
  return { namespace: EXT_NAMESPACE, ...(url ? { url } : {}), cookies };
}

/* ---------------- handshake ---------------- */

/**
 * Sends the apply request to the injected content script and waits for the
 * extension's ack. Resolves `null` when nothing answered within `timeoutMs`
 * (extension not installed / context invalidated) — the caller falls back to
 * the manual import flow.
 */
export function postApplyCookies(payload: ApplyPayload, timeoutMs = 2500): Promise<ApplyAck | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let settled = false;

    const finish = (ack: ApplyAck | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(ack);
    };

    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return;
      const d = e.data as
        | { namespace?: string; type?: string; requestId?: string; ok?: boolean; applied?: number; errors?: string[] }
        | null;
      if (!d || d.namespace !== EXT_NAMESPACE) return;
      if (d.type !== "BRNT_APPLY_COOKIES_RESULT" || d.requestId !== requestId) return;
      finish({ ok: d.ok === true, applied: d.applied ?? 0, errors: Array.isArray(d.errors) ? d.errors : [] });
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    window.addEventListener("message", onMsg);
    window.postMessage({ ...payload, type: "BRNT_APPLY_COOKIES", requestId }, window.location.origin);
  });
}

/**
 * Tracks whether the BRNT Cookie Importer extension is present. The content
 * script announces itself on load and answers our periodic pings, so this
 * detects the extension no matter which side loaded first.
 */
export function useBrntExtension(): boolean {
  const [detected, setDetected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let pings = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return;
      const d = e.data as { namespace?: string; type?: string } | null;
      if (!d || d.namespace !== EXT_NAMESPACE || d.type !== "BRNT_EXTENSION_HERE") return;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (!cancelled) setDetected(true);
    };

    window.addEventListener("message", onMsg);
    const ping = () => {
      if (pings++ > 30) {
        if (timer) clearInterval(timer);
        return;
      }
      window.postMessage({ namespace: EXT_NAMESPACE, type: "BRNT_EXTENSION_PING" }, window.location.origin);
    };
    ping();
    timer = setInterval(ping, 1500);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("message", onMsg);
    };
  }, []);

  return detected;
}
