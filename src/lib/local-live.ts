// Device-local fallback pool for the right-side LIVE panel (Task 45).
//
// On deployments where the server KV write path is unavailable (e.g. Netlify
// Blobs write failures), pushed live sessions are kept in this browser's
// localStorage instead, so the live panel keeps working on THAT device.
// Entries are marked addedBy: "device" and rendered with a "device" badge.
//
// The pool is intentionally small and capped; quota errors are swallowed.

export interface LocalLiveSession {
  id: string; // always prefixed "dev_" so the UI can route deletes locally
  target: string;
  host: string;
  label: string;
  cookieHeader: string;
  cookies?: { name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expirationDate?: number }[];
  addedAt: string;
  addedBy: "device";
}

const KEY = "brnt-local-live";
const MAX = 40;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function listLocalLive(): LocalLiveSession[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const j = JSON.parse(raw);
    if (!Array.isArray(j)) return [];
    return j.filter((s) => s && typeof s.id === "string" && s.id.startsWith("dev_"));
  } catch {
    return [];
  }
}

export function addLocalLive(input: {
  target: string;
  label?: string;
  cookieHeader: string;
  cookies?: LocalLiveSession["cookies"];
}): LocalLiveSession | null {
  const target = String(input.target || "").trim();
  const cookieHeader = String(input.cookieHeader || "").trim();
  if (!target || !cookieHeader) return null;
  const host = hostOf(target);
  if (!host) return null;
  const entry: LocalLiveSession = {
    id: `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    target,
    host,
    label: String(input.label || "").slice(0, 120),
    cookieHeader,
    ...(input.cookies?.length ? { cookies: input.cookies } : {}),
    addedAt: new Date().toISOString(),
    addedBy: "device",
  };
  try {
    const next = [entry, ...listLocalLive()].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return null; // quota or storage disabled
  }
  return entry;
}

export function removeLocalLive(id: string): void {
  try {
    const next = listLocalLive().filter((s) => s.id !== id);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}
