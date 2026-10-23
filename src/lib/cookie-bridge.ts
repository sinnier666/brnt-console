// Client bridge to the BRNT Cookie Bridge browser extension.
// The extension (MV3, externally_connectable) listens for BRNT_PING / BRNT_APPLY
// messages from this origin and applies cookies via chrome.cookies, then opens
// the real site in a new tab.

export const BRNT_EXT_ID = "apjmfngppaojjhbhocapbbdcflekebol";

interface BridgeCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
}

type ChromeLike = {
  runtime?: {
    sendMessage?: (
      id: string,
      msg: unknown,
      cb?: (resp: unknown) => void
    ) => unknown;
  };
};

function chromeApi(): ChromeLike | null {
  if (typeof window === "undefined") return null;
  const c = (window as unknown as { chrome?: ChromeLike }).chrome;
  return c && c.runtime && c.runtime.sendMessage ? c : null;
}

function sendToBridge<T>(msg: unknown, timeoutMs = 2500): Promise<T | null> {
  const c = chromeApi();
  if (!c || !c.runtime?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    try {
      c.runtime!.sendMessage!(BRNT_EXT_ID, msg, (resp: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve((resp as T) ?? null);
        }
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

export interface PingResponse {
  ok?: boolean;
  name?: string;
  version?: string;
}

export async function pingBridge(): Promise<PingResponse | null> {
  return sendToBridge<PingResponse>({ type: "BRNT_PING" }, 1500);
}

export interface ApplyResponse {
  ok?: boolean;
  set?: number;
  failed?: { name: string; error: string }[];
  error?: string;
}

/**
 * Ask the extension to apply cookies to `url` and open it in a new tab.
 * @param cookies either a raw header string ("a=1; b=2") or parsed cookie objects
 */
export async function bridgeApplyAndOpen(
  url: string,
  cookies: string | BridgeCookie[],
  open = true
): Promise<ApplyResponse | null> {
  return sendToBridge<ApplyResponse>({ type: "BRNT_APPLY", url, cookies, open }, 15000);
}

/** Parse a cookie header string into bridge-ready objects. */
export function cookiesForBridge(headerOrJson: string): BridgeCookie[] {
  const t = headerOrJson.trim();
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t) as BridgeCookie[];
      if (Array.isArray(arr)) return arr;
    } catch {
      /* fall through */
    }
  }
  return t
    .split(/[;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf("=");
      if (eq <= 0) return null;
      return { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() };
    })
    .filter(Boolean) as BridgeCookie[];
}
