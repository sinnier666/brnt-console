// Bulk row parsing for the LoginProbe console.
// Supported line formats (separators: | tab , or colon):
//   https://site.com/login : user : pass
//   site.com/login | user | pass
//   user : pass                    (uses the locked Login page URL)
//   https://site.com               (cookie-only row; needs shared cookies)

import { normalizeProbeUrl } from "@/lib/probe-url";

export interface BulkRow {
  line: string;
  url: string | null;
  username: string;
  password: string;
  cookieOnly: boolean;
  error?: string;
}

export function resolveRowUrl(raw: string): string {
  return normalizeProbeUrl(raw);
}

export function looksLikeUrl(s: string): boolean {
  return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(s.trim());
}

export function parseBulkLine(line: string, hasSharedCookies: boolean): BulkRow | null {
  const r = line.trim();
  if (!r) return null;
  if (r.startsWith("#")) return null; // comment row

  // url | user | pass  (or tab/comma)
  const sepMatch = r.match(/^(\S+)\s*[|\t,]\s*([^\s|\t,][^|\t,]*?)\s*[|\t,]\s*(.+)$/);
  if (sepMatch) {
    const [, u, user, pass] = sepMatch;
    if (looksLikeUrl(u)) {
      try {
        return { line: r, url: resolveRowUrl(u), username: user.trim(), password: pass.trim(), cookieOnly: false };
      } catch {
        return { line: r, url: null, username: user.trim(), password: pass.trim(), cookieOnly: false, error: "bad URL" };
      }
    }
  }

  // user | pass (two fields, no url) — pipes/tabs/commas
  const two = r.split(/\s*[|\t,]\s*/);
  if (two.length === 2 && two[0] && two[1] && !looksLikeUrl(two[0])) {
    return { line: r, url: null, username: two[0].trim(), password: two[1].trim(), cookieOnly: false };
  }

  // url : user : pass  (colon-separated; first field must look like a URL)
  const colon = r.match(/^((?:https?:\/\/)?[^\s:]+(?::\d+)?(?:\/[^\s:]*)?)\s*:\s*([^:]+?)\s*:\s*(.+)$/);
  if (colon && looksLikeUrl(colon[1])) {
    try {
      return { line: r, url: resolveRowUrl(colon[1]), username: colon[2].trim(), password: colon[3].trim(), cookieOnly: false };
    } catch {
      /* fall through */
    }
  }

  // user : pass (single colon)
  const singleColon = r.match(/^([^:\s][^:]*?)\s*:\s*([^\s:].*)$/);
  if (singleColon && !looksLikeUrl(singleColon[1])) {
    return { line: r, url: null, username: singleColon[1].trim(), password: singleColon[2].trim(), cookieOnly: false };
  }

  // cookie-only row: the whole line is a URL
  if (looksLikeUrl(r)) {
    if (!hasSharedCookies) {
      return { line: r, url: null, username: "", password: "", cookieOnly: true, error: "no shared cookies" };
    }
    try {
      return { line: r, url: resolveRowUrl(r), username: "", password: "", cookieOnly: true };
    } catch {
      return { line: r, url: null, username: "", password: "", cookieOnly: true, error: "bad URL" };
    }
  }

  return { line: r, url: null, username: "", password: "", cookieOnly: false, error: "unrecognised format" };
}

export function parseBulkText(text: string, hasSharedCookies: boolean): BulkRow[] {
  const out: BulkRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = parseBulkLine(line, hasSharedCookies);
    if (row) out.push(row);
  }
  return out;
}
