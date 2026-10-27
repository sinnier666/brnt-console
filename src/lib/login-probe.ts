// Login probe engine: detects target login forms, submits credentials
// (with a wrong-password baseline for smart comparison), or validates
// cookie-only sessions. All requests run server-side to bypass CORS.

import { CookieJar, ParsedCookie, parseCookieText } from "./cookies";
import { createSession } from "./session-store";
import type { FormDetection, ProbeResult } from "./probe-types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SUCCESS_KEYWORDS = [
  "sign out",
  "log out",
  "logout",
  "welcome back",
  "signed in as",
  "logged in as",
  "my account",
  "dashboard",
];
// High-precision failure phrases ONLY. Bare words like "invalid" or "try again"
// are deliberately NOT here: big sites (Prime Video) embed internal JS error
// identifiers ("InvalidStatusCode", "CrossDomainSSOInvalidUrl", "Try again"
// player buttons) in their normal pages, which caused every cookie check to
// report a false "session likely rejected" (Task 56).
const FAIL_KEYWORDS = [
  "incorrect email or phone",
  "invalid email or phone",
  "incorrect username or password",
  "invalid username or password",
  "invalid email or password",
  "invalid credentials",
  "invalid login",
  "invalid username",
  "invalid password",
  "wrong password",
  "login failed",
  "log in failed",
  "sign in failed",
  "authentication failed",
  "your session has expired",
  "session expired",
  "account has been locked",
  "account is locked",
  "too many attempts",
];

export function normalizeProbeUrl(v: string): string {
  let s = String(v || "").trim();
  if (!s) throw new Error("URL is empty");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) URLs supported");
  return u.href;
}

interface FetchOutcome {
  finalUrl: string;
  status: number;
  html: string;
  redirectChain: string[];
  setCookies: string[];
  bytes: number;
}

async function fetchWithRedirects(
  url: string,
  opts: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    jar: CookieJar;
    maxRedirects?: number;
  }
): Promise<FetchOutcome> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = url;
  const chain: string[] = [];
  let last: FetchOutcome = { finalUrl: url, status: 0, html: "", redirectChain: chain, setCookies: [], bytes: 0 };

  for (let i = 0; i <= maxRedirects; i++) {
    const cookieHeader = opts.jar.headerFor(current);
    const res = await fetch(current, {
      method: opts.method && i === 0 ? opts.method : "GET",
      body: opts.method && i === 0 ? opts.body : undefined,
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(opts.method && i === 0
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
        ...(opts.headers || {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(25_000),
    }).catch((e) => {
      throw new Error(`fetch failed: ${String(e && e.message ? e.message : e)}`);
    });

    const setCookies = [...res.headers.getSetCookie ? res.headers.getSetCookie() : []];
    const status = res.status;
    const loc = res.headers.get("location");
    const buf = status >= 300 && status < 400 && loc ? "" : await res.text().catch(() => "");

    last = {
      finalUrl: current,
      status,
      html: buf,
      redirectChain: chain,
      setCookies,
      bytes: buf.length,
    };

    if (setCookies.length) opts.jar.setFromResponse(current, setCookies);

    if (loc && status >= 300 && status < 400) {
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        break;
      }
      chain.push(`${status} → ${next.href}`);
      current = next.href;
      continue;
    }
    break;
  }
  return last;
}

export function detectLoginForm(html: string, baseUrl: string): FormDetection {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)];
  for (const m of forms) {
    const form = m[0];
    if (!/type\s*=\s*["']?password["']?/i.test(form)) continue;

    const actionAttr = (form.match(/action\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
    const methodAttr = ((form.match(/method\s*=\s*["']([^"']*)["']/i) || [])[1] || "post").toLowerCase();

    let actionUrl = baseUrl;
    try {
      actionUrl = new URL(actionAttr || baseUrl, baseUrl).href;
    } catch {
      /* keep baseUrl */
    }

    let usernameField = "";
    let passwordField = "";
    const hiddenFields: { name: string; value: string }[] = [];

    const inputs = [...form.matchAll(/<input\b[^>]*>/gi)];
    for (const im of inputs) {
      const tag = im[0];
      const name = (tag.match(/name\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
      const type = ((tag.match(/type\s*=\s*["']([^"']*)["']/i) || [])[1] || "text").toLowerCase();
      const value = (tag.match(/value\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
      if (type === "password" && !passwordField) passwordField = name;
      else if (type === "hidden" && name) hiddenFields.push({ name, value });
      else if (!usernameField && name && ["text", "email", "tel", ""].includes(type)) {
        if (/user|email|login|account|id/i.test(name)) usernameField = name;
      }
    }
    if (!usernameField) {
      // first non-password, non-hidden text-ish input
      for (const im of inputs) {
        const tag = im[0];
        const name = (tag.match(/name\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
        const type = ((tag.match(/type\s*=\s*["']([^"']*)["']/i) || [])[1] || "text").toLowerCase();
        if (name && !["password", "hidden", "submit", "checkbox", "radio", "file"].includes(type)) {
          usernameField = name;
          break;
        }
      }
    }

    if (passwordField) {
      return { found: true, actionUrl, method: methodAttr === "get" ? "GET" : "POST", usernameField, passwordField, hiddenFields };
    }
  }
  return { found: false };
}

function title(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 120) : "";
}

function countKeywords(html: string, keywords: string[]): number {
  const low = html.toLowerCase();
  let n = 0;
  for (const k of keywords) {
    let idx = low.indexOf(k);
    while (idx !== -1) {
      n++;
      idx = low.indexOf(k, idx + k.length);
    }
  }
  return n;
}

function snippet(html: string, kw: string): string {
  const low = html.toLowerCase();
  const idx = low.indexOf(kw);
  if (idx === -1) return "";
  const start = Math.max(0, idx - 60);
  return html.slice(start, idx + kw.length + 60).replace(/\s+/g, " ").trim().slice(0, 180);
}

function newId(): string {
  return Date.now().toString(10) + "-" + Math.random().toString(36).slice(2, 7);
}

function jarHostOf(target: string): string {
  try {
    return new URL(target).hostname;
  } catch {
    return "";
  }
}

// ---------------- credential probe ----------------

export async function probeWithCreds(
  target: string,
  username: string,
  password: string,
  cookieText?: string
): Promise<ProbeResult> {
  const started = Date.now();
  const evidence: string[] = [];
  const id = newId();
  const base: ProbeResult = {
    id,
    target,
    username,
    password,
    verdict: "unknown",
    confidence: "low",
    evidence,
    checkedAt: new Date().toISOString(),
    cookieSource: cookieText?.trim() || null,
  };

  const jar = new CookieJar();
  const parsed: ParsedCookie[] = cookieText?.trim() ? parseCookieText(cookieText).cookies : [];
  if (parsed.length) {
    jar.seedParsed(parsed, jarHostOf(target));
    evidence.push(`Seeded ${parsed.length} cookie(s) from provided input`);
  }

  let page: FetchOutcome;
  try {
    page = await fetchWithRedirects(target, { jar });
  } catch (e) {
    return { ...base, verdict: "unknown", evidence: [`GET ${target} failed: ${String(e)}`], error: String(e) };
  }
  evidence.push(`GET ${target} → HTTP ${page.status}`);
  if (page.redirectChain.length) evidence.push(`Redirect chain: ${page.redirectChain.join(" | ")}`);

  const det = detectLoginForm(page.html, page.finalUrl);
  base.detection = det;
  if (!det.found) {
    return {
      ...base,
      httpStatus: page.status,
      pageTitle: title(page.html),
      finalUrl: page.finalUrl,
      elapsedMs: Date.now() - started,
      evidence: [...evidence, "No login form detected on the page"],
    };
  }
  evidence.push(
    `Detected login form → action=${det.actionUrl} method=${det.method}, username field "${det.usernameField}", password field "${det.passwordField}"`
  );
  if (det.hiddenFields?.length) {
    evidence.push(`Including hidden/CSRF fields: ${det.hiddenFields.map((h) => h.name).join(", ")}`);
  }

  const buildBody = (pass: string) => {
    const params = new URLSearchParams();
    for (const h of det.hiddenFields || []) params.set(h.name, h.value);
    if (det.usernameField) params.set(det.usernameField, username);
    if (det.passwordField) params.set(det.passwordField, pass);
    const extra = [...formExtraFields(page.html)];
    for (const [k, v] of extra) if (!params.has(k)) params.set(k, v);
    return params.toString();
  };

  // baseline: wrong password
  const baselineJar = new CookieJar();
  if (parsed.length) baselineJar.seedParsed(parsed, jarHostOf(target));
  let baseline: FetchOutcome;
  try {
    baseline = await fetchWithRedirects(det.actionUrl, {
      method: det.method,
      body: buildBody(password + "__brnt_probe"),
      jar: baselineJar,
    });
  } catch (e) {
    baseline = { finalUrl: det.actionUrl, status: 0, html: "", redirectChain: [], setCookies: [], bytes: 0 };
    evidence.push(`Baseline probe failed: ${String(e)}`);
  }
  const baselineFail = countKeywords(baseline.html, FAIL_KEYWORDS);
  const baselineSuccess = countKeywords(baseline.html, SUCCESS_KEYWORDS);
  evidence.push(
    `Baseline probe (wrong password) → HTTP ${baseline.status}, ${baseline.bytes} bytes, keywords: fail=${baselineFail}, success=${baselineSuccess}`
  );

  // real attempt
  const realJar = new CookieJar();
  if (parsed.length) realJar.seedParsed(parsed, jarHostOf(target));
  let real: FetchOutcome;
  try {
    real = await fetchWithRedirects(det.actionUrl, {
      method: det.method,
      body: buildBody(password),
      jar: realJar,
    });
  } catch (e) {
    return { ...base, verdict: "unknown", evidence: [...evidence, `POST failed: ${String(e)}`], error: String(e) };
  }
  evidence.push(`POST → HTTP ${real.status}, ${real.bytes} bytes`);
  if (real.redirectChain.length) evidence.push(`Redirect chain: ${real.redirectChain.join(" | ")}`);

  const realFail = countKeywords(real.html, FAIL_KEYWORDS);
  const realSuccess = countKeywords(real.html, SUCCESS_KEYWORDS);

  const cookiesSet = realJar.all().map((c) => c.name);
  if (cookiesSet.length) evidence.push(`New cookies after POST: ${cookiesSet.join(", ")}`);

  let verdict: ProbeResult["verdict"] = "unknown";
  let confidence: ProbeResult["confidence"] = "low";
  let usedKw = "";

  if (realSuccess > baselineSuccess && realSuccess > 0) {
    verdict = "success";
    confidence = "high";
    for (const k of SUCCESS_KEYWORDS) {
      if (real.html.toLowerCase().includes(k)) {
        usedKw = k;
        break;
      }
    }
    evidence.push(`Success keyword(s) after real POST, absent in baseline → logged in ("${usedKw}")`);
  } else if (realFail > 0 && realSuccess === 0) {
    // both real and baseline rejected → the real credentials are wrong too
    verdict = "fail";
    confidence = realFail > baselineFail || realFail >= 2 ? "high" : "medium";
    for (const k of FAIL_KEYWORDS) {
      if (real.html.toLowerCase().includes(k)) {
        usedKw = k;
        break;
      }
    }
    evidence.push(`Failure keyword(s) after real POST ("${usedKw}") and no success indicators → rejected`);
  } else if (real.bytes > 0 && baseline.bytes > 0 && Math.abs(real.bytes - baseline.bytes) > 400 && realSuccess > 0) {
    verdict = "success";
    confidence = "medium";
    evidence.push("Response differs from baseline with success indicators → likely logged in");
  } else {
    evidence.push("Real response similar to baseline without clear indicators → verdict unknown");
  }

  let sessionId: string | null = null;
  if (verdict === "success") {
    const session = await createSession(page.finalUrl, realJar);
    sessionId = session.id;
  }

  const kwHtml = verdict === "success" ? real.html : real.html;
  return {
    ...base,
    verdict,
    confidence,
    httpStatus: real.status,
    pageTitle: title(real.html) || title(page.html),
    finalUrl: real.finalUrl,
    redirected: real.redirectChain.length > 0,
    elapsedMs: Date.now() - started,
    baseline: { bytes: baseline.bytes, failKeywords: baselineFail, successKeywords: baselineSuccess },
    snapshot: { bytes: real.bytes, path: safePath(real.finalUrl) },
    snippet: usedKw ? snippet(kwHtml, usedKw) : undefined,
    cookiesSet,
    sessionId,
  };
}

function safePath(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return "/";
  }
}

function formExtraFields(html: string): [string, string][] {
  // submit buttons with names (common in real forms)
  const out: [string, string][] = [];
  const buttons = [...html.matchAll(/<button\b[^>]*name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/button>/gi)];
  for (const b of buttons.slice(0, 2)) {
    const text = b[2].replace(/<[^>]*>/g, "").trim().toLowerCase();
    if (/log.?in|sign.?in|submit|continue/.test(text)) out.push([b[1], b[2].replace(/<[^>]*>/g, "").trim()]);
  }
  return out;
}

// ---------------- cookie-only probe ----------------

export async function probeWithCookies(target: string, cookieText: string): Promise<ProbeResult> {
  const started = Date.now();
  const evidence: string[] = [];
  const id = newId();
  const base: ProbeResult = {
    id,
    target,
    username: "(cookie session)",
    password: "",
    verdict: "unknown",
    confidence: "low",
    evidence,
    checkedAt: new Date().toISOString(),
    cookieSource: cookieText,
  };

  const parsed = parseCookieText(cookieText).cookies;
  if (!parsed.length) {
    return { ...base, evidence: ["No cookies recognised in input"], error: "no cookies" };
  }
  evidence.push(
    `Session check with ${parsed.length} cookie(s): ${parsed.map((c) => c.name).join(", ").slice(0, 220)}`
  );

  const jar = new CookieJar();
  jar.seedParsed(parsed, jarHostOf(target));

  let withC: FetchOutcome;
  try {
    withC = await fetchWithRedirects(target, { jar });
  } catch (e) {
    return { ...base, evidence: [`GET with cookies failed: ${String(e)}`], error: String(e) };
  }
  const chainStr = withC.redirectChain.length ? ` | ${withC.redirectChain.join(" | ")}` : "";
  evidence.push(`GET with cookies → HTTP ${withC.status}${chainStr}`);

  const host = (jarHostOf(target) || jarHostOf(withC.finalUrl) || "").toLowerCase();
  const finalPath = safePath(withC.finalUrl) || "/";

  // Authenticity gates — decisive verdicts that do NOT depend on keywords.
  // Keyword matching alone gets fooled: logged-OUT Netflix pages embed words
  // like "logout" inside their reactContext JSON (clearMslDataOnLogout etc.).
  const earlyResult = (
    verdict: ProbeResult["verdict"],
    confidence: ProbeResult["confidence"],
    sessionId: string | null = null
  ): ProbeResult => ({
    ...base,
    verdict,
    confidence,
    httpStatus: withC.status,
    pageTitle: title(withC.html),
    finalUrl: withC.finalUrl,
    redirected: withC.redirectChain.length > 0,
    elapsedMs: Date.now() - started,
    snapshot: { bytes: withC.bytes, path: finalPath },
    cookiesSet: parsed.map((c) => c.name),
    sessionId,
  });

  if (/(^|\.)netflix\.com$/.test(host)) {
    if (!parsed.some((c) => /^netflixid$/i.test(c.name))) {
      evidence.push(
        "This cookie set has no NetflixId — the one cookie that actually holds a Netflix login. It cannot authenticate Netflix regardless of what the page contains."
      );
      return earlyResult("fail", "high");
    }
  }

  // Bot-protection challenge detection (Fastly "Client Challenge", Cloudflare,
  // PerimeterX, …). When a site gates the console's SERVER IP it serves a tiny
  // JS challenge shell instead of the real page — identical with or without
  // cookies. The session then cannot be judged from the server at all; the
  // cookies themselves may be perfectly valid. Must run BEFORE any page-path
  // gates so a challenge shell can never be mistaken for a members' page.
  const pageT = title(withC.html);
  const CHALLENGE_RE =
    /_fs-ch-|client challenge|just a moment|attention required|cf-browser-verification|cf_chl_|perimeterx|px-captcha|captcha-delivery|ddos-guard/i;
  const challengeHit =
    CHALLENGE_RE.test(withC.html) || (withC.bytes > 0 && withC.bytes < 4000 && /challenge/i.test(pageT));
  if (challengeHit) {
    evidence.push(
      `The site served the console's server a BOT-PROTECTION challenge page (${withC.bytes} bytes${pageT ? `, title "${pageT}"` : ""}) instead of the real page — it is gating the server's IP.`
    );
    evidence.push(
      "The session cannot be judged from here, and this says NOTHING bad about your cookies — they may be perfectly valid. Verify by opening the site through the Cookie Bridge (it opens in YOUR browser, where the real page loads)."
    );
    return earlyResult("unknown", "low");
  }

  if (/(^|\.)netflix\.com$/.test(host)) {
    if (/(^|\/)(login|signin)(\/|$)/i.test(finalPath)) {
      evidence.push(
        `Netflix sent your cookies to ${finalPath} — the members' area stays locked, so this session is rejected or expired.`
      );
      return earlyResult("fail", "high");
    }
    if (/(^|\/)(browse|profiles|watch|LatestListPage|YourAccount)(\/|$)/i.test(finalPath)) {
      evidence.push(`Netflix served the members' area (${finalPath}) → the session is alive.`);
      const session = await createSession(withC.finalUrl, jar);
      return earlyResult("success", "high", session.id);
    }
    // Netflix has NO keyword ambiguity: valid cookies ALWAYS land in the
    // members' area (/browse, /profiles, …). If the cookies instead land on
    // the PUBLIC marketing page (locale root like /us-en/, /hk-ko/, or the
    // bare root with the sign-up title), the session is dead — full stop.
    // Reporting this structurally beats keyword roulette: the marketing page
    // embeds strings like "logout" in its own JS, which let a DEAD session
    // luck into a false "success" when the geo variant differed between the
    // with/without-cookie fetches (user report, Task 67).
    const marketingLanding =
      /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/i.test(finalPath) ||
      /watch tv shows online|watch movies online|unlimited movies/.test(pageT.toLowerCase());
    if (marketingLanding) {
      evidence.push(
        `Netflix served the PUBLIC marketing page (${finalPath}${pageT ? `, title "${pageT}"` : ""}) instead of the members' area → this session is rejected, expired, or logged out.`
      );
      return earlyResult("fail", "high");
    }
    // other Netflix paths: fall through to the generic checks below
  }

  const successKw = SUCCESS_KEYWORDS.find((k) => withC.html.toLowerCase().includes(k));
  const failKw = FAIL_KEYWORDS.find((k) => withC.html.toLowerCase().includes(k));

  // comparison fetch without cookies
  const bareJar = new CookieJar();
  let withoutC: FetchOutcome;
  try {
    withoutC = await fetchWithRedirects(target, { jar: bareJar });
  } catch {
    withoutC = { finalUrl: target, status: 0, html: "", redirectChain: [], setCookies: [], bytes: 0 };
  }

  const noCookiesKw = successKw ? withoutC.html.toLowerCase().includes(successKw) : false;
  const sameish =
    withoutC.status === withC.status &&
    Math.abs(withoutC.bytes - withC.bytes) < Math.max(2000, withoutC.bytes * 0.02) &&
    safePath(withoutC.finalUrl) === safePath(withC.finalUrl);

  // A page that still lands on a login/sign-in route WITH cookies attached
  // means the site does not recognize the session — this outranks keywords
  // (login pages often embed "logout" in their internal JSON).
  const landedAuth = /(^|\/)(login|signin|sign-in|logon|authenticate)(\/|$)/i.test(finalPath);

  // Keywords that only make sense on a real logged-in page. "logout"/"my
  // account"/"dashboard" also live in site code and anonymous-page JSON.
  const STRONG_SUCCESS = new Set(["sign out", "welcome back", "signed in as", "logged in as"]);

  let verdict: ProbeResult["verdict"] = "unknown";
  let confidence: ProbeResult["confidence"] = "low";

  if (landedAuth) {
    verdict = "fail";
    confidence = "medium";
    evidence.push(
      `With your cookies the site still lands on its login page (${finalPath}) → it does not recognize this session.`
    );
  } else if (successKw && !noCookiesKw) {
    verdict = "success";
    confidence = STRONG_SUCCESS.has(successKw) ? "high" : "medium";
    evidence.push(`Success keywords with cookies: ${successKw}`);
    evidence.push(
      `GET without cookies → HTTP ${withoutC.status}, ${withoutC.bytes} bytes, path "${safePath(withoutC.finalUrl)}"`
    );
    evidence.push(
      STRONG_SUCCESS.has(successKw)
        ? "Logged-in indicator(s) appear only with your cookies → session is alive."
        : `Indicator "${successKw}" appears only with your cookies, but this word can also live in site code — treated as moderate proof.`
    );
  } else if (successKw && noCookiesKw && !sameish) {
    if (STRONG_SUCCESS.has(successKw)) {
      verdict = "success";
      confidence = "medium";
      evidence.push(`Success keywords with cookies; responses differ → likely logged in`);
    } else {
      evidence.push(
        `Indicator "${successKw}" also exists on the logged-out page (site code/UI strings) and the responses differ only slightly → not proof of a session.`
      );
    }
  } else if (failKw) {
    verdict = "fail";
    confidence = "medium";
    evidence.push(`Failure keyword with cookies: ${failKw} → session likely rejected`);
  } else if (
    /primevideo\.com|amazon\.[a-z.]+/i.test(withC.finalUrl) &&
    /\/offers\/nonprimehomepage/i.test(withC.finalUrl)
  ) {
    // Prime Video bounced the session to its logged-out landing page —
    // unambiguous proof the cookies are no longer authenticated.
    verdict = "fail";
    confidence = "high";
    evidence.push("Prime redirected your cookies to the logged-out /offers/nonprimehomepage → session is NOT authenticated (cookies expired, invalidated, or the export is missing auth cookies like at-main / x-main).");
  } else {
    evidence.push(
      `GET without cookies → HTTP ${withoutC.status}, ${withoutC.bytes} bytes, path "${safePath(withoutC.finalUrl)}"`
    );
    evidence.push(
      `Comparison: same landing path, body ${withoutC.bytes}B vs ${withC.bytes}B (${withoutC.bytes ? Math.round((1 - withC.bytes / withoutC.bytes) * 1000) / 10 : 0}% difference)`
    );
    evidence.push(
      "Response is identical with and without cookies — the page may be JavaScript-rendered, so the session cannot be confirmed from HTML alone."
    );
  }

  let sessionId: string | null = null;
  if (verdict === "success") {
    const session = await createSession(withC.finalUrl, jar);
    sessionId = session.id;
  }

  return {
    ...base,
    verdict,
    confidence,
    httpStatus: withC.status,
    pageTitle: title(withC.html),
    finalUrl: withC.finalUrl,
    redirected: withC.redirectChain.length > 0,
    elapsedMs: Date.now() - started,
    snapshot: { bytes: withC.bytes, path: safePath(withC.finalUrl) },
    snippet: successKw ? snippet(withC.html, successKw) : undefined,
    cookiesSet: parsed.map((c) => c.name),
    sessionId,
  };
}
