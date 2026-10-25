// Netflix-style "magic link" generator.
//
// Produces links shaped like: https://netflix.com/?nftoken=<token>
// where <token> is a compact, URL-safe encoding of the session cookies:
//   BR1.<base64url(deflate-raw(JSON))>   compressed (preferred)
//   BR0.<base64url(JSON)>                uncompressed fallback
//
// The BRNT Cookie Bridge extension (v1.2+) intercepts navigations that carry
// ?nftoken= (alias ?brnttoken=), applies the cookies via chrome.cookies,
// strips the parameter and reloads — the opener lands logged-in on the real site.

import { parseCookieText, type ParsedCookie } from "./cookies";

export interface CompactCookie {
  n: string; // name
  v: string; // value
  d?: string; // domain (leading dot kept = domain cookie)
  p?: string; // path
  s?: 1; // secure
  h?: 1; // httpOnly
  ss?: string; // sameSite (lax | strict | no_restriction)
  e?: number; // expirationDate (epoch seconds)
}

export interface MagicPayload {
  v: 1; // format version
  u: string; // URL the link opens (cookies are applied for its origin)
  c: CompactCookie[];
}

export interface MagicLink {
  link: string;
  count: number;
  encoded: "BR1" | "BR0";
  bytes: number;
}

// ---------- base64url helpers ----------

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------- compression ----------

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const cs = new CompressionStream("deflate-raw");
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

// ---------- compact cookie shape ----------

export function compactCookies(list: ParsedCookie[]): CompactCookie[] {
  const out: CompactCookie[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (!c.name) continue;
    const key = `${c.domain || ""}|${c.path || "/"}|${c.name}`;
    if (seen.has(key)) continue; // first occurrence wins (browser semantics)
    seen.add(key);
    const k: CompactCookie = { n: c.name, v: c.value == null ? "" : String(c.value) };
    if (c.domain) k.d = c.domain;
    if (c.path && c.path !== "/") k.p = c.path;
    if (c.secure) k.s = 1;
    if (c.httpOnly) k.h = 1;
    if (c.sameSite) {
      const ss = String(c.sameSite).toLowerCase();
      const mapped =
        ss === "no_restriction" || ss === "none"
          ? "no_restriction"
          : ss === "lax"
            ? "lax"
            : ss === "strict"
              ? "strict"
              : null;
      if (mapped) k.ss = mapped;
    }
    let exp = Number(c.expirationDate);
    if (Number.isFinite(exp) && exp > 1e12) exp = exp / 1000; // ms -> s
    if (exp > 0) k.e = Math.round(exp);
    out.push(k);
  }
  return out;
}

// ---------- encode / decode ----------

export function encodeMagicPayloadJson(p: MagicPayload): string {
  // stable-ish key order keeps payloads small and deterministic
  return JSON.stringify({ v: p.v, u: p.u, c: p.c });
}

export async function encodeMagicToken(p: MagicPayload): Promise<{ token: string; encoded: "BR1" | "BR0" }> {
  const json = encodeMagicPayloadJson(p);
  const raw = strToBytes(json);
  const z = await deflateRaw(raw);
  if (z && z.length < raw.length) {
    return { token: "BR1." + bytesToB64url(z), encoded: "BR1" };
  }
  return { token: "BR0." + bytesToB64url(raw), encoded: "BR0" };
}

/** Decode a token (used in console for verification / tests). Mirrors shared.js in the extension. */
export async function decodeMagicToken(token: string): Promise<MagicPayload | null> {
  const m = /^BR([01])\.([A-Za-z0-9\-_]+)$/.exec(String(token || "").trim());
  if (!m) return null;
  let jsonText: string;
  const bytes = b64urlToBytes(m[2]);
  if (m[1] === "1") {
    if (typeof DecompressionStream === "undefined") throw new Error("DecompressionStream unsupported");
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
    jsonText = new TextDecoder().decode(await new Response(stream).arrayBuffer());
  } else {
    jsonText = new TextDecoder().decode(bytes);
  }
  const p = JSON.parse(jsonText) as MagicPayload;
  if (!p || typeof p !== "object" || !Array.isArray(p.c) || p.c.length === 0) return null;
  if (!p.c.every((c) => c && typeof c.n === "string" && typeof c.v === "string")) return null;
  return p;
}

function b64urlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- public builder ----------

/**
 * Build the shareable magic link.
 * @param targetUrl  the page to open (usually the checked login URL / final URL)
 * @param cookieSource header string, Netscape file, Cookie-Editor JSON, or parsed cookie objects
 */
export async function buildMagicLink(
  targetUrl: string,
  cookieSource: string | ParsedCookie[]
): Promise<MagicLink> {
  const parsed =
    typeof cookieSource === "string"
      ? parseCookieText(cookieSource)
      : { cookies: cookieSource };
  if (!parsed.cookies.length) throw new Error("no cookies available to encode");

  // clean the target: absolute + drop any previous token params
  const u = new URL(/^https?:\/\//i.test(targetUrl) ? targetUrl : "https://" + targetUrl);
  u.searchParams.delete("nftoken");
  u.searchParams.delete("brnttoken");
  u.hash = "";
  const base = u.toString();

  const payload: MagicPayload = { v: 1, u: base, c: compactCookies(parsed.cookies) };
  const { token, encoded } = await encodeMagicToken(payload);

  const sep = base.includes("?") ? "&" : "?";
  const link = base + sep + "nftoken=" + token;
  const tokenBytes = token.length * 0.75; // approx decoded size
  return { link, count: payload.c.length, encoded, bytes: Math.round(tokenBytes) };
}
