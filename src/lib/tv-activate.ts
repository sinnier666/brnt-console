// TV device activation driven by a stored session jar — no credentials needed.
//
//  Crunchyroll (port of the reference CrunchyTVActivator flow):
//    etp_rt cookie → OAuth token (grant_type=etp_rt_cookie, public web client)
//    → account/subs info (plan, country, renewal) → POST /auth/v1/device {user_code}
//  Netflix (netflix.com/tv8 "enter the code displayed on your TV"):
//    GET /tv8 → authURL (csrf) + logged-in check → form POST
//    flowMode=enterTvLoginRendezvousCode with the 8-digit rendezvous code.
//
// Server-side only (uses fetch / curl subprocess + raw cookie headers; no browser APIs).

import { execFile } from "node:child_process";
import type { ParsedCookie } from "./cookies";

const CR_UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";
const NF_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
// Crunchyroll's PUBLIC web client id (same one the site itself uses).
const CR_BASIC = "Basic bm9haWhkZXZtXzZpeWcwYThsMHE6";

export interface TvAccountInfo {
  email: string;
  emailVerified: boolean;
  country: string;
  plan: string;
  expiryDate: string;
  daysLeft: number | null;
}

export type TvResult =
  | { ok: true; message: string; info?: TvAccountInfo }
  | { ok: false; error: string };

function clone(list: ParsedCookie[]): ParsedCookie[] {
  return list.map((c) => ({ ...c }));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseBetween(text: string, left: string, right: string): string {
  const s = text.indexOf(left);
  if (s === -1) return "";
  const start = s + left.length;
  const e = text.indexOf(right, start);
  return e === -1 ? "" : text.slice(start, e);
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/** Cookie header for a request URL — only cookies whose domain matches the host. */
function cookieHeaderFor(list: ParsedCookie[], url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* keep empty — send everything */
  }
  const matched = list.filter((c) => {
    if (!host) return true;
    const d = (c.domain || "").replace(/^\./, "").toLowerCase();
    if (!d) return true; // host-less cookies: best effort
    return host === d || host.endsWith("." + d);
  });
  return matched.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Merge Set-Cookie pairs from a response into the working cookie list. */
function applySetCookies(list: ParsedCookie[], raws: string[]): void {
  for (const sc of raws) {
    const pair = sc.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const existing = list.find((c) => c.name === name);
    if (existing) existing.value = value;
    else list.push({ name, value });
  }
}

function mergeSetCookies(list: ParsedCookie[], res: Response): void {
  const raws =
    typeof (res.headers as Headers).getSetCookie === "function"
      ? (res.headers as Headers).getSetCookie()
      : [];
  applySetCookies(list, raws);
}

function uuid(): string {
  return crypto.randomUUID();
}

// ---------- Crunchyroll transport ----------
// crunchyroll.com sits behind Cloudflare bot management that challenges Node's
// fetch (TLS fingerprint → "Just a moment...", cf-mitigated: challenge) — the
// same reason the reference tool uses cloudscraper. Plain curl passes, so the
// crunchyroll transport shells out to curl (bundled with Windows 10+ and
// present on Netlify/Amazon Linux images) and only falls back to fetch when
// curl is unavailable.

interface CrResponse {
  status: number;
  text: string;
  setCookies: string[];
}

function curlFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutSec = 45
): Promise<CrResponse> {
  return new Promise((resolve, reject) => {
    const args = ["-s", "-i", "--max-time", String(timeoutSec), "-X", method];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    if (body) args.push("--data-raw", body);
    args.push(url);
    execFile(
      "curl",
      args,
      { maxBuffer: 10 * 1024 * 1024, timeout: (timeoutSec + 5) * 1000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || "");
        if (err && !out) {
          reject(new Error(`curl unavailable: ${err.message.slice(0, 120)}`));
          return;
        }
        const sep = out.indexOf("\r\n\r\n");
        const headPart = sep === -1 ? out : out.slice(0, sep);
        const bodyPart = sep === -1 ? "" : out.slice(sep + 4);
        const lines = headPart.split("\r\n");
        const status = parseInt(lines[0]?.split(" ")[1] || "0", 10) || 0;
        const setCookies = lines
          .filter((l) => /^set-cookie:/i.test(l))
          .map((l) => l.replace(/^set-cookie:\s*/i, ""));
        resolve({ status, text: bodyPart, setCookies });
      }
    );
  });
}

async function crRequest(
  cookies: ParsedCookie[],
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { ...opts.headers, cookie: cookieHeaderFor(cookies, url) };
  let res: CrResponse;
  try {
    res = await curlFetch(url, opts.method || "GET", headers, opts.body);
  } catch {
    // curl missing — fall back to fetch (may hit the Cloudflare challenge)
    const fr = await fetch(url, { method: opts.method || "GET", headers, body: opts.body });
    res = {
      status: fr.status,
      text: await fr.text(),
      setCookies:
        typeof (fr.headers as Headers).getSetCookie === "function"
          ? (fr.headers as Headers).getSetCookie()
          : [],
    };
  }
  applySetCookies(cookies, res.setCookies);
  if (res.status === 403 && /just a moment/i.test(res.text.slice(0, 2000))) {
    throw new Error("Crunchyroll challenged the server (Cloudflare) — retry, or run this from the local console.");
  }
  return { status: res.status, text: res.text };
}

const CR_COUNTRY: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  IN: "India",
  CA: "Canada",
  AU: "Australia",
  DE: "Germany",
  FR: "France",
  BR: "Brazil",
  JP: "Japan",
};

async function crToken(cookies: ParsedCookie[]): Promise<{ token: string; profileId: string }> {
  const url = "https://www.crunchyroll.com/auth/v1/token";
  const { status, text } = await crRequest(cookies, url, {
    method: "POST",
    headers: {
      "user-agent": CR_UA,
      accept: "application/json, text/plain, */*",
      "content-type": "application/x-www-form-urlencoded",
      authorization: CR_BASIC,
      origin: "https://www.crunchyroll.com",
      referer: "https://www.crunchyroll.com/activate",
      "etp-anonymous-id": uuid(),
    },
    body: `device_id=${uuid()}&device_type=${encodeURIComponent("Chrome on Android")}&grant_type=etp_rt_cookie`,
  });
  if (status !== 200) {
    const j = safeJson(text);
    const ctx = Array.isArray(j?.context) ? (j.context as { field?: string }[]) : [];
    if (ctx.some((c) => c?.field === "etp_rt")) {
      throw new Error(
        "Session has no etp_rt cookie — run a crunchyroll.com login check (or paste cookies that include etp_rt) first."
      );
    }
    const why = String(j?.code || j?.error || `HTTP ${status}`);
    const rawErr = `${String(j?.code || "")} ${String(j?.error || "")}`;
    throw new Error(
      /invalid_grant/i.test(rawErr)
        ? "etp_rt was rejected (session expired or rotated) — refresh the Crunchyroll session."
        : `Crunchyroll token exchange failed (${why})`
    );
  }
  const token = parseBetween(text, '"access_token":"', '"');
  if (!token) throw new Error("Crunchyroll token response had no access_token.");
  const profileId = parseBetween(text, '"profile_id":"', '"');
  return { token, profileId };
}

async function crAuthedGet(cookies: ParsedCookie[], token: string, url: string): Promise<string> {
  const { text } = await crRequest(cookies, url, {
    headers: {
      "user-agent": CR_UA,
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${token}`,
    },
  });
  return text;
}

/** Best-effort account info (plan / country / renewal) for the panel display. */
export async function crunchyrollTvInfo(jar: ParsedCookie[]): Promise<TvAccountInfo> {
  const cookies = clone(jar);
  const { token, profileId } = await crToken(cookies);

  const meText = await crAuthedGet(cookies, token, "https://beta-api.crunchyroll.com/accounts/v1/me");
  const externalId = parseBetween(meText, '"external_id":"', '"');
  const emailVerified = meText.includes('"email_verified":true');
  const email = parseBetween(meText, '"email":"', '"');

  let plan = "FREE";
  let country = "";
  if (externalId) {
    const skuText = await crAuthedGet(
      cookies,
      token,
      `https://beta-api.crunchyroll.com/subs/v1/subscriptions/${externalId}/products`
    );
    const sku = parseBetween(skuText, ',"sku":"', '"');
    if (sku) {
      const benefitsText = await crAuthedGet(
        cookies,
        token,
        `https://beta-api.crunchyroll.com/subs/v1/subscriptions/${externalId}/benefits`
      );
      country = parseBetween(benefitsText, '"subscription_country":"', '"');
      const streams = parseBetween(benefitsText, '"benefit":"concurrent_', '"');
      if (streams) {
        const planMap: Record<string, string> = { "1": "FAN", "4": "MEGA FAN", "6": "ULTIMATE FAN" };
        plan = planMap[streams] || "PREMIUM";
      }
    }
  }

  let expiryDate = "";
  let daysLeft: number | null = null;
  if (profileId) {
    const renewalText = await crAuthedGet(
      cookies,
      token,
      `https://beta-api.crunchyroll.com/subs/v4/accounts/${profileId}/subscriptions`
    );
    if (renewalText.includes('"nextRenewalDate":"')) {
      expiryDate = parseBetween(renewalText, '"nextRenewalDate":"', "T");
      if (expiryDate) {
        const exp = Date.parse(expiryDate + "T00:00:00Z");
        if (Number.isFinite(exp)) {
          daysLeft = Math.max(0, Math.round((exp - Date.now()) / 86400000));
        }
      }
    }
  }

  return {
    email,
    emailVerified,
    country: CR_COUNTRY[country] || country || "Unknown",
    plan,
    expiryDate,
    daysLeft,
  };
}

/** Activate a TV device code using the jar's etp_rt session. */
export async function crunchyrollTvActivate(jar: ParsedCookie[], userCode: string): Promise<TvResult> {
  const code = userCode.trim().toUpperCase();
  if (!code) return { ok: false, error: "Enter the activation code shown on your TV." };
  const cookies = clone(jar);
  if (!cookies.some((c) => c.name.toLowerCase() === "etp_rt")) {
    return {
      ok: false,
      error:
        "Session has no etp_rt cookie — run a crunchyroll.com login check (or paste cookies that include etp_rt) first.",
    };
  }
  try {
    const { token } = await crToken(cookies);
    // Touch /activate first — mirrors the reference flow and refreshes its cookies.
    try {
      await crRequest(cookies, "https://www.crunchyroll.com/activate", {
        headers: {
          "user-agent": CR_UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } catch {
      /* non-fatal */
    }
    const { status, text } = await crRequest(cookies, "https://www.crunchyroll.com/auth/v1/device", {
      method: "POST",
      headers: {
        "user-agent": CR_UA,
        accept: "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: "https://www.crunchyroll.com",
        referer: "https://www.crunchyroll.com/activate",
        "etp-anonymous-id": uuid(),
      },
      body: JSON.stringify({ user_code: code }),
    });
    if (status === 200) {
      let info: TvAccountInfo | undefined;
      try {
        info = await crunchyrollTvInfo(jar);
      } catch {
        /* info is cosmetic */
      }
      return {
        ok: true,
        message: "TV ACTIVATION SUCCESSFUL — your TV is now linked to this Crunchyroll account.",
        info,
      };
    }
    const j = safeJson(text);
    const errCode = String(j?.code || "");
    if (/user_code_activation_failure|forbidden/i.test(errCode)) {
      return { ok: false, error: "Invalid or expired code — generate a new one on your TV and try again." };
    }
    if (/not_found/i.test(errCode)) {
      return { ok: false, error: "Code not found — check the code and make sure it is still valid." };
    }
    return { ok: false, error: `Activation failed (${errCode || `HTTP ${status}`})` };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

// ---------- Netflix (netflix.com/tv8) ----------

/**
 * Enter the rendezvous code shown on the TV at netflix.com/tv8, using the
 * session jar as the logged-in browser. The code is 8 digits (Netflix's own
 * validationRegex ^[0-9]{8}$ on the tv8 form).
 */
export async function netflixTvActivate(jar: ParsedCookie[], userCode: string): Promise<TvResult> {
  const code = userCode.trim();
  if (!/^[0-9]{8}$/.test(code)) {
    return { ok: false, error: "TV code must be 8 digits — the number shown on your TV screen." };
  }
  const cookies = clone(jar);
  if (!cookies.some((c) => c.name === "NetflixId")) {
    return { ok: false, error: "Session has no NetflixId — refresh the Netflix session first." };
  }
  try {
    const tv8 = "https://www.netflix.com/tv8";
    const getRes = await fetch(tv8, {
      headers: {
        "user-agent": NF_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        cookie: cookieHeaderFor(cookies, tv8),
      },
    });
    mergeSetCookies(cookies, getRes);
    const html = await getRes.text();
    const membership = /"membershipStatus":"(\w+)"/.exec(html)?.[1] || "";
    if (membership === "ANONYMOUS") {
      return {
        ok: false,
        error: "Netflix reports the session as logged OUT (ANONYMOUS) — the cookies are dead. Refresh the session first.",
      };
    }
    const authURL =
      /name="authURL" value="([^"]+)"/.exec(html)?.[1] || /"authURL":"([^"]+)"/.exec(html)?.[1] || "";
    if (!authURL) {
      return { ok: false, error: "Could not read the tv8 form (Netflix page changed?) — try again later." };
    }

    const postRes = await fetch(tv8, {
      method: "POST",
      headers: {
        "user-agent": NF_UA,
        "content-type": "application/x-www-form-urlencoded",
        "accept-language": "en-US,en;q=0.9",
        origin: "https://www.netflix.com",
        referer: tv8,
        cookie: cookieHeaderFor(cookies, tv8),
      },
      body: new URLSearchParams({
        flow: "websiteSignUp",
        authURL,
        flowMode: "enterTvLoginRendezvousCode",
        withFields: "tvLoginRendezvousCode,isTvUrl2",
        tvLoginRendezvousCode: code,
        isTvUrl2: "true",
        code: "",
        action: "nextAction",
      }).toString(),
    });
    mergeSetCookies(cookies, postRes);
    const postHtml = await postRes.text();
    const postMembership = /"membershipStatus":"(\w+)"/.exec(postHtml)?.[1] || "";
    if (postMembership === "ANONYMOUS") {
      return { ok: false, error: "Netflix ended the session during the code entry — cookies look dead, refresh the session." };
    }
    const rejected =
      /isn[’']t valid/i.test(postHtml) ||
      /no longer valid/i.test(postHtml) ||
      /has expired/i.test(postHtml) ||
      /incorrect code/i.test(postHtml) ||
      /too many attempts/i.test(postHtml);
    if (rejected && /enterTvLoginRendezvousCode/.test(postHtml)) {
      return { ok: false, error: "Netflix rejected the code (invalid or expired) — generate a new code on the TV and retry." };
    }
    const landedAwayFromForm =
      !/enterTvLoginRendezvousCode/.test(postHtml) || !/\/tv8/.test(postRes.url || tv8);
    if (landedAwayFromForm) {
      return {
        ok: true,
        message:
          "Code accepted — your TV should be signed in now. If the TV still shows the code screen, back out and reopen the Netflix app.",
      };
    }
    return {
      ok: false,
      error: "Netflix returned the code form again — the code may be wrong or expired. Generate a new one and retry.",
    };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}
