"use client";

// Right-side LIVE panel: admin-curated pool of working cookie sessions.
// - Members see the list and use the NFT button to open the live page logged-in.
// - Only the admin can add (paste cookies or push from a result) and remove.
// - Every apply (NFT open / cookies download) is recorded to the member's
//   date-bucketed .txt usage log; members clear their own records, the admin
//   downloads everything by date.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2,
  Radio,
  RefreshCw,
  Ticket,
  Download,
  Trash2,
  Plus,
  Lock,
  LockOpen,
  FileText,
  Activity,
  Link2,
} from "lucide-react";
import { cookiesFromSource, toNetscape, toHeader, downloadText, filePart, isNetflixHost } from "@/lib/session-export";
import { buildMagicLink } from "@/lib/magic-link";
import type { ParsedCookie } from "@/lib/cookies";

/** buildMagicLink with a flat error return for the panel's open flow. */
async function buildMagicLinkSafe(target: string, cookies: Parameters<typeof buildMagicLink>[1]): Promise<string | null> {
  try {
    const built = await buildMagicLink(target, cookies);
    return built.link;
  } catch {
    return null;
  }
}

/**
 * Freshest cookies for a live entry — mirrors the result dialog:
 * 1. source probe session jar (refetched live, survives Amazon token rotation)
 * 2. rich cookies stored on the entry (domain/secure/httpOnly/expiry intact)
 * 3. legacy header-string parse (old entries only)
 */
async function resolveLiveCookies(s: LiveSession): Promise<ParsedCookie[]> {
  if (s.sessionId) {
    const j = await fetch(`/api/replay-cookies/${encodeURIComponent(s.sessionId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null);
    if (j?.jar?.length) return j.jar as ParsedCookie[];
  }
  if (s.cookies?.length) return s.cookies;
  return cookiesFromSource(s.cookieHeader);
}

export interface LiveSession {
  id: string;
  target: string;
  host: string;
  label: string;
  cookieHeader: string;
  cookies?: ParsedCookie[];
  sessionId?: string;
  addedAt: string;
  addedBy: string;
}

interface UsageEntry {
  at: string;
  member: string;
  action: string;
  site: string;
}

function timeAgo(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "";
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

interface Props {
  accessKey: string;
  isAdmin: boolean;
  adminKey: string;
  /** bumped by the app when a result row is pushed from the results dialog */
  refreshTick: number;
  onAdminUnlock: (key: string) => Promise<string | null>; // null = ok, string = error
  onAdminLock: () => void;
  onChanged: () => void;
}

export function LivePanel({ accessKey, isAdmin, adminKey, refreshTick, onAdminUnlock, onAdminLock, onChanged }: Props) {
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [note, setNote] = useState("");

  // admin add form
  const [showAdd, setShowAdd] = useState(false);
  const [addTarget, setAddTarget] = useState("");
  const [addCookies, setAddCookies] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");

  // admin unlock
  const [unlockKey, setUnlockKey] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState("");

  // member activity
  const [mine, setMine] = useState<UsageEntry[]>([]);
  const [mineTotal, setMineTotal] = useState(0);
  const [mineBusy, setMineBusy] = useState(false);

  // admin logs
  const [dates, setDates] = useState<{ date: string; count: number }[]>([]);
  const [logBusy, setLogBusy] = useState("");

  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (accessKey) h["x-brnt-access"] = accessKey;
    if (isAdmin && adminKey) h["x-brnt-admin"] = adminKey;
    return h;
  }, [accessKey, isAdmin, adminKey]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/live-sessions", { headers: authHeaders(), cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok) {
        setSessions(j.sessions as LiveSession[]);
      } else {
        setSessions([]);
        setLoadError(j?.message || "Could not load live sessions.");
      }
    } catch {
      setLoadError("Could not reach the live sessions server.");
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  const refreshMine = useCallback(async () => {
    if (!accessKey) {
      setMine([]);
      setMineTotal(0);
      return;
    }
    try {
      const res = await fetch("/api/usage-log?mine=1", { headers: authHeaders(), cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok) {
        setMine(j.entries as UsageEntry[]);
        setMineTotal(Number(j.total) || 0);
      }
    } catch {
      /* non-fatal */
    }
  }, [accessKey, authHeaders]);

  const refreshDates = useCallback(async () => {
    if (!isAdmin) {
      setDates([]);
      return;
    }
    try {
      const res = await fetch("/api/usage-log?list=1", { headers: authHeaders(), cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok) setDates(j.dates as { date: string; count: number }[]);
    } catch {
      /* non-fatal */
    }
  }, [isAdmin, authHeaders]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshTick]);

  useEffect(() => {
    refreshMine();
    refreshDates();
  }, [refreshMine, refreshDates]);

  /** Record an apply action to the member's usage log (.txt by date). */
  async function record(action: string, site: string, cookieHeader: string) {
    try {
      await fetch("/api/usage-log", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ action, site, cookieHeader }),
      });
      refreshMine();
    } catch {
      /* logging must never block the apply */
    }
  }

  /**
   * One-click live access — same flow for every site: a placeholder tab is
   * opened synchronously inside the click gesture (popup-blocker-proof), then
   * navigated to a native nftoken (Netflix) or a BR1 magic link (all others).
   */
  async function openLive(s: LiveSession) {
    setNote("");
    const isNetflix = isNetflixHost(s.target);
    // Placeholder tab opened IN the gesture itself — this is what makes the
    // one-click work for magic-link sites (primevideo, …), not just Netflix.
    const w = window.open("", "_blank");
    if (w) {
      try {
        w.document.write(
          '<p style="font:14px/1.6 system-ui,sans-serif;padding:28px;color:#555">Building your login link…</p>'
        );
      } catch {
        /* ignore */
      }
    }
    try {
      // Freshest cookies — refetched from the source session like the result
      // dialog does, so the open uses the SAME payload the dialog would.
      const cookies = await resolveLiveCookies(s);
      if (!cookies.length) {
        w?.close();
        setNote(`"${s.host}" has no usable cookies — ask the admin to update it.`);
        return;
      }
      let link: string | null = null;
      let kind: "native" | "magic" = "magic";
      if (isNetflix && cookies.some((c) => c.name === "NetflixId")) {
        // Netflix path — mint a native token (any browser, no extension);
        // a failed mint falls back to the magic link in the SAME tab.
        const res = await fetch("/api/nftoken", {
          method: "POST",
          headers: { "content-type": "application/json", "x-brnt-access": accessKey },
          body: JSON.stringify({ jar: cookies }),
        });
        const j = await res.json().catch(() => null);
        if (res.ok && j?.ok && j.link) {
          link = String(j.link);
          kind = "native";
        }
      }
      if (!link) {
        const built = await buildMagicLinkSafe(s.target, cookies);
        if (!built) {
          w?.close();
          setNote(`Could not build a login link for ${s.host}.`);
          return;
        }
        link = built;
        kind = "magic";
      }
      // Navigate first, log in the background — logging must never delay the open.
      if (w) {
        w.location.href = link;
      } else {
        // Placeholder itself was blocked (rare) — one direct attempt, then copy.
        const w2 = window.open(link, "_blank", "noopener");
        if (!w2) {
          await navigator.clipboard.writeText(link).catch(() => {});
          setNote(`Popup blocked — the ${kind} link was copied; open it in a new tab to log in.`);
        }
      }
      record(kind === "native" ? "nft-open" : "magic-open", s.host, toHeader(cookies));
    } catch (e) {
      w?.close();
      setNote("Open failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function dlCookies(s: LiveSession) {
    const cookies = await resolveLiveCookies(s);
    if (!cookies.length) {
      setNote(`"${s.host}" has no usable cookies.`);
      return;
    }
    downloadText(`brnt-live-cookies-${filePart(s.host)}.txt`, toNetscape(cookies, s.host), "text/plain");
    await record("cookies-download", s.host, toHeader(cookies));
  }

  async function addSession() {
    setAddError("");
    setAddBusy(true);
    try {
      const res = await fetch("/api/live-sessions", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ target: addTarget, cookies: addCookies, label: addLabel }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok) {
        setAddCookies("");
        setAddLabel("");
        setAddTarget("");
        setShowAdd(false);
        await refresh();
        onChanged();
        await record("live-added", j.record?.host || "-", "");
      } else {
        setAddError(j?.error || j?.message || `Add failed (HTTP ${res.status})`);
      }
    } catch {
      setAddError("Could not reach the server.");
    } finally {
      setAddBusy(false);
    }
  }

  async function removeSession(s: LiveSession) {
    setNote("");
    try {
      const res = await fetch(`/api/live-sessions?id=${encodeURIComponent(s.id)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        await refresh();
        onChanged();
      } else {
        setNote("Remove failed.");
      }
    } catch {
      setNote("Could not reach the server.");
    }
  }

  async function unlockAdmin() {
    setUnlockError("");
    setUnlockBusy(true);
    const err = await onAdminUnlock(unlockKey);
    setUnlockBusy(false);
    if (err) setUnlockError(err);
    else setUnlockKey("");
  }

  async function clearMine() {
    setMineBusy(true);
    try {
      await fetch("/api/usage-log", { method: "DELETE", headers: authHeaders() });
      await refreshMine();
    } catch {
      /* ignore */
    } finally {
      setMineBusy(false);
    }
  }

  async function downloadDate(date: string) {
    setLogBusy(date);
    try {
      const res = await fetch(`/api/usage-log?date=${encodeURIComponent(date)}`, { headers: authHeaders() });
      if (res.ok) {
        downloadText(`brnt-usage-${date}.txt`, await res.text(), "text/plain");
      }
    } catch {
      /* ignore */
    } finally {
      setLogBusy("");
    }
  }

  async function clearDate(date: string | "all") {
    setLogBusy(date);
    try {
      const qs = date === "all" ? "?all=1" : `?date=${encodeURIComponent(date)}`;
      await fetch(`/api/usage-log${qs}`, { method: "DELETE", headers: authHeaders() });
      await Promise.all([refreshDates(), refreshMine()]);
    } catch {
      /* ignore */
    } finally {
      setLogBusy("");
    }
  }

  return (
    <aside
      aria-label="Live sessions panel"
      className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-3 lg:sticky lg:top-16 h-fit"
    >
      {/* header */}
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-emerald-400" />
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-300">
          Live sessions {sessions.length > 0 && <span className="text-zinc-500">({sessions.length})</span>}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          {isAdmin && (
            <span className="rounded border border-sky-500/50 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-sky-400">ADMIN</span>
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-zinc-400" onClick={() => refresh()} aria-label="Refresh live sessions">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Working cookie sessions shared by the admin. Hit <b className="text-zinc-400">NFT</b> to open the live page logged-in.
      </p>

      {/* admin unlock / lock */}
      {!isAdmin ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 space-y-2">
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">
            <LockOpen className="h-3 w-3" /> Admin access
          </p>
          <div className="flex gap-1.5">
            <Input
              value={unlockKey}
              onChange={(e) => setUnlockKey(e.target.value)}
              placeholder="Admin key"
              className="h-8 bg-zinc-950 border-zinc-800 text-xs"
              autoComplete="off"
              onKeyDown={(e) => e.key === "Enter" && unlockAdmin()}
            />
            <Button size="sm" className="h-8 bg-sky-500 hover:bg-sky-600 text-sky-950 font-bold" onClick={unlockAdmin} disabled={unlockBusy}>
              {unlockBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />} Unlock
            </Button>
          </div>
          {unlockError && <p className="text-[11px] text-rose-400">{unlockError}</p>}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 flex-1 border-sky-500/50 text-sky-400 hover:bg-sky-500/10"
            onClick={() => setShowAdd((v) => !v)}
          >
            <Plus className="h-3.5 w-3.5" /> Add live cookies
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-zinc-500 hover:text-rose-400" onClick={onAdminLock} aria-label="Lock admin mode">
            <Lock className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* admin add form */}
      {isAdmin && showAdd && (
        <div className="space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5">
          <div className="space-y-1">
            <Label className="text-[11px] text-zinc-400">Cookies (header or Netscape .txt paste)</Label>
            <textarea
              value={addCookies}
              onChange={(e) => setAddCookies(e.target.value)}
              placeholder={"NetflixId=…; SafeNetflix=…\n— or —\n# Netscape HTTP Cookie File\n.netflix.com\tTRUE\t/\tTRUE\t0\tNetflixId\t…"}
              rows={5}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Input
              value={addTarget}
              onChange={(e) => setAddTarget(e.target.value)}
              placeholder="Site URL (optional)"
              className="h-8 bg-zinc-950 border-zinc-800 text-xs"
              autoComplete="off"
            />
            <Input
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              placeholder="Label (optional)"
              className="h-8 bg-zinc-950 border-zinc-800 text-xs"
              autoComplete="off"
            />
          </div>
          <Button size="sm" className="h-8 w-full bg-sky-500 hover:bg-sky-600 text-sky-950 font-bold" onClick={addSession} disabled={addBusy || !addCookies.trim()}>
            {addBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add to live panel
          </Button>
          {addError && <p className="text-[11px] text-rose-400">{addError}</p>}
        </div>
      )}

      {/* list */}
      {loadError && <p className="text-xs text-amber-400">{loadError}</p>}
      {note && <p className="text-xs text-amber-400">{note}</p>}

      {!loading && sessions.length === 0 && !loadError && (
        <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
          No live sessions yet.{" "}
          {isAdmin ? "Paste cookies above or hit the sky button on a success result in the results list." : "The admin adds working cookies here."}
        </div>
      )}

      <ul className="space-y-2">
        {sessions.map((s) => {
          const netflix = isNetflixHost(s.target);
          return (
            <li key={s.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 space-y-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <span className="font-mono text-xs text-zinc-200 truncate">{s.host}</span>
                {s.label && <span className="text-[11px] text-zinc-500 truncate hidden sm:inline">{s.label}</span>}
                <span className="ml-auto text-[10px] text-zinc-600 shrink-0">{timeAgo(s.addedAt)}</span>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => removeSession(s)}
                    className="shrink-0 text-zinc-600 hover:text-rose-400 transition-colors"
                    aria-label={`Remove ${s.host} from the live panel`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  onClick={() => openLive(s)}
                  className={`h-8 flex-1 font-bold text-xs ${netflix ? "bg-red-600 hover:bg-red-700 text-white" : "bg-emerald-500 hover:bg-emerald-600 text-emerald-950"}`}
                  title={netflix ? "Mint a native nftoken and open Netflix logged-in" : "Build a magic link and open the site logged-in (needs Cookie Bridge)"}
                >
                  <Ticket className="h-3.5 w-3.5" /> NFT {netflix ? "· one-click login" : "· open live"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 border-zinc-800 text-zinc-300 hover:bg-zinc-900 text-xs"
                  onClick={() => dlCookies(s)}
                  title="Download these cookies as Netscape .txt"
                >
                  <Download className="h-3.5 w-3.5" /> .txt
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* member activity */}
      {accessKey && (
        <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
          <div className="flex items-center gap-1.5">
            <Activity className="h-3 w-3 text-zinc-400" />
            <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
              My activity {mineTotal > 0 && <span className="text-zinc-600 normal-case">({mineTotal})</span>}
            </p>
            {mineTotal > 0 && (
              <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px] text-zinc-500 hover:text-rose-400" onClick={clearMine} disabled={mineBusy}>
                {mineBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Clear mine
              </Button>
            )}
          </div>
          {mine.length === 0 ? (
            <p className="text-[11px] text-zinc-600">Nothing applied yet — your nftoken opens and cookie downloads are recorded here.</p>
          ) : (
            <ul className="space-y-1 max-h-40 overflow-y-auto">
              {mine.slice(0, 10).map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex items-center gap-2 text-[11px] text-zinc-400">
                  <span className="text-zinc-600 shrink-0">{timeAgo(e.at)}</span>
                  <span className="font-mono text-zinc-300 truncate">{e.action}</span>
                  <span className="truncate text-zinc-500">{e.site}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* admin logs by date */}
      {isAdmin && (
        <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">
            <FileText className="h-3 w-3" /> Usage logs (.txt by date)
          </p>
          {dates.length === 0 ? (
            <p className="text-[11px] text-zinc-600">No records yet. Every member apply is logged per date.</p>
          ) : (
            <ul className="space-y-1">
              {dates.map((d) => (
                <li key={d.date} className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-zinc-300">{d.date}</span>
                  <span className="text-zinc-600">{d.count}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-emerald-400" onClick={() => downloadDate(d.date)} disabled={logBusy === d.date} aria-label={`Download ${d.date} log`}>
                      {logBusy === d.date ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-zinc-500 hover:text-rose-400" onClick={() => clearDate(d.date)} disabled={logBusy === d.date} aria-label={`Clear ${d.date} log`}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </li>
              ))}
              <li className="pt-1">
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-zinc-500 hover:text-rose-400" onClick={() => clearDate("all")} disabled={Boolean(logBusy)}>
                  <Trash2 className="h-3 w-3" /> Clear all logs
                </Button>
              </li>
            </ul>
          )}
        </div>
      )}

      <p className="flex items-start gap-1 text-[10px] leading-relaxed text-zinc-600">
        <Link2 className="h-3 w-3 shrink-0 mt-0.5" />
        Netflix entries mint a native nftoken (any browser). Other sites build a BR1 magic link — opening it needs the Cookie Bridge extension.
      </p>
    </aside>
  );
}
