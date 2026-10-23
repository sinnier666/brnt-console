// Cookie parsing (Netscape / JSON / header) + cookie jar utilities.
// Mirrors the BRNT Cookie Bridge extension parser (shared.js).

export interface ParsedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
}

export interface CookieParseResult {
  format: string | null;
  cookies: ParsedCookie[];
}

export function parseCookieText(raw: string): CookieParseResult {
  const t = String(raw == null ? "" : raw).trim();
  if (!t) return { format: null, cookies: [] };

  if (t[0] === "[" || t[0] === "{") {
    try {
      const j = JSON.parse(t);
      const parsed = parseJsonCookies(j);
      if (parsed.length) return { format: "JSON", cookies: parsed };
    } catch {
      /* fall through */
    }
  }

  const nc = parseNetscape(t);
  if (nc.length) return { format: "Netscape cookies.txt", cookies: nc };

  const hc = parseHeaderCookies(t);
  if (hc.length) return { format: "header (name=value; ...)", cookies: hc };

  return { format: null, cookies: [] };
}

/** "name1=v1; name2=v2" header string from parsed cookies (jar or source). */
export function cookiePairsFromSource(cookies: ParsedCookie[] | string): string {
  if (typeof cookies === "string") {
    return parseCookieText(cookies).cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Most likely site URL from cookie domains (most specific wins). */
export function cookieDomainToSiteUrl(cookies: ParsedCookie[]): string | null {
  const hosts = [
    ...new Set(
      cookies
        .filter((c) => c.domain)
        .map((c) => c.domain!.replace(/^\./, "").toLowerCase())
        .filter((h) => h.includes("."))
    ),
  ];
  if (!hosts.length) return null;
  hosts.sort((a, b) => b.length - a.length);
  return "https://" + hosts[0] + "/";
}

// ---------------- cookie jar ----------------

export interface JarCookie {
  name: string;
  value: string;
  domain: string; // stored lowercase; leading dot = domain cookie
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expires?: number; // epoch seconds; undefined = session cookie
}

export class CookieJar {
  private jar = new Map<string, JarCookie>();

  private key(c: JarCookie) {
    return `${c.domain}|${c.path}|${c.name}`;
  }

  set(c: JarCookie) {
    this.jar.set(this.key(c), c);
  }

  /** Seed from parsed cookie list (user-provided cookies). */
  seedParsed(list: ParsedCookie[], fallbackHost: string) {
    for (const c of list) {
      this.set({
        name: c.name,
        value: c.value,
        domain: (c.domain ? c.domain.toLowerCase() : fallbackHost.toLowerCase()),
        path: c.path || "/",
        secure: c.secure ?? fallbackHost.startsWith("https"),
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite,
        expires: c.expirationDate && c.expirationDate > 0 ? c.expirationDate : undefined,
      });
    }
  }

  /** Consume Set-Cookie headers from a response. */
  setFromResponse(responseUrl: string, setCookieHeaders: string[]) {
    const u = new URL(responseUrl);
    for (const raw of setCookieHeaders) {
      const parts = raw.split(";");
      const kv = parts[0]?.trim();
      if (!kv || !kv.includes("=")) continue;
      const eq = kv.indexOf("=");
      const name = kv.slice(0, eq).trim();
      const value = kv.slice(eq + 1).trim();
      if (!name) continue;
      let domain = u.hostname.toLowerCase();
      let path = "/";
      let secure = false;
      let httpOnly = false;
      let expires: number | undefined;
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i].trim();
        const peq = p.indexOf("=");
        const attr = (peq === -1 ? p : p.slice(0, peq)).trim().toLowerCase();
        const val = peq === -1 ? "" : p.slice(peq + 1).trim();
        if (attr === "domain" && val) {
          domain = val.toLowerCase().replace(/^\./, ".");
        } else if (attr === "path" && val) {
          path = val;
        } else if (attr === "secure") {
          secure = true;
        } else if (attr === "httponly") {
          httpOnly = true;
        } else if (attr === "expires") {
          const t = Date.parse(val);
          if (Number.isFinite(t)) expires = t / 1000;
        } else if (attr === "max-age") {
          const n = parseInt(val, 10);
          if (Number.isFinite(n)) expires = n > 0 ? Date.now() / 1000 + n : 0;
        }
      }
      if (expires === 0) {
        this.jar.delete(this.key({ name, value, domain, path, secure, httpOnly: false }));
        continue;
      }
      this.set({ name, value, domain, path, secure, httpOnly, expires });
    }
  }

  private domainMatches(cookieDomain: string, host: string, secure: boolean): boolean {
    const cd = cookieDomain.toLowerCase();
    const h = host.toLowerCase();
    if (cd.startsWith(".")) {
      const bare = cd.slice(1);
      return h === bare || h.endsWith("." + bare);
    }
    // host-only cookie: exact host match
    return h === cd;
  }

  /** Cookie header for a request URL, per RFC 6265-ish matching. */
  headerFor(url: string): string {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return "";
    }
    const now = Date.now() / 1000;
    const parts: string[] = [];
    for (const c of this.jar.values()) {
      if (c.expires !== undefined && c.expires <= now) continue;
      if (!this.domainMatches(c.domain, u.hostname, c.secure)) continue;
      if (!u.pathname.startsWith(c.path) && !(c.path === "/" )) continue;
      if (c.secure && u.protocol !== "https:") continue;
      parts.push(`${c.name}=${c.value}`);
    }
    return parts.join("; ");
  }

  all(): JarCookie[] {
    return [...this.jar.values()];
  }

  toJSON(): { cookies: ParsedCookie[] } {
    return {
      cookies: this.all().map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expires,
      })),
    };
  }
}

// ---------------- format parsers ----------------

function parseNetscape(t: string): ParsedCookie[] {
  const out: ParsedCookie[] = [];
  for (let line of t.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      continue;
    }
    let parts = line.split("\t");
    if (parts.length < 7) parts = line.split(/\s+/);
    if (parts.length < 7) continue;
    const [domain, , path, secure, expires, name, ...valueRest] = parts;
    if (!name) continue;
    const cookie: ParsedCookie = {
      name,
      value: valueRest.join("\t"),
      path: path || "/",
      secure: String(secure).toUpperCase() === "TRUE",
      httpOnly,
    };
    if (domain) cookie.domain = domain;
    const exp = parseInt(expires, 10);
    if (exp > 0) cookie.expirationDate = exp;
    out.push(cookie);
  }
  return out;
}

function parseJsonCookies(j: unknown): ParsedCookie[] {
  const norm = (o: Record<string, unknown>): ParsedCookie | null => {
    if (!o || typeof o !== "object" || !o.name) return null;
    const c: ParsedCookie = {
      name: String(o.name),
      value: o.value == null ? "" : String(o.value),
    };
    if (o.domain) c.domain = String(o.domain);
    if (o.path) c.path = String(o.path);
    if (o.secure != null) c.secure = !!o.secure;
    if (o.httpOnly != null) c.httpOnly = !!o.httpOnly;
    if (o.sameSite) c.sameSite = String(o.sameSite);
    let exp = Number(o.expirationDate != null ? o.expirationDate : o.expires);
    if (Number.isFinite(exp) && exp > 1e12) exp = exp / 1000;
    if (exp > 0) c.expirationDate = exp;
    if (o.session === true) c.expirationDate = undefined;
    return c;
  };
  if (Array.isArray(j)) {
    return j.map((x) => norm(x as Record<string, unknown>)).filter(Boolean) as ParsedCookie[];
  }
  if (j && typeof j === "object") {
    const obj = j as Record<string, unknown>;
    if (obj.name) {
      const one = norm(obj);
      return one ? [one] : [];
    }
    return Object.entries(obj)
      .filter(([k]) => k && typeof k === "string")
      .map(([k, v]) => ({ name: k, value: v == null ? "" : String(v) }));
  }
  return [];
}

function parseHeaderCookies(t: string): ParsedCookie[] {
  const out: ParsedCookie[] = [];
  const seen = new Set<string>();
  for (const piece of t.split(/[;\n]+/)) {
    const p = piece.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    const key = name + "=" + value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, value });
  }
  return out;
}
