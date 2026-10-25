// Client-safe URL normalization (no server imports).

export function normalizeProbeUrl(v: string): string {
  let s = String(v || "").trim();
  if (!s) throw new Error("URL is empty");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) URLs supported");
  return u.href;
}
