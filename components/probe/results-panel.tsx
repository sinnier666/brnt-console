"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  Copy,
  Share2,
  Download,
  Trash2,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Link2,
  Ticket,
  Eye,
  EyeOff,
  Radio,
} from "lucide-react";
import type { ProbeResult } from "@/lib/probe-types";
import { parseCookieText, cookiePairsFromSource, ParsedCookie } from "@/lib/cookies";
import { buildMagicLink, type MagicLink } from "@/lib/magic-link";
import {
  hostOf,
  filePart,
  downloadText,
  toNetscape,
  toHeader,
  isNetflixHost,
  resolveNftoken,
  nftokenTxtFor,
  type Nftoken,
} from "@/lib/session-export";

// ---------- helpers ----------

// ---------- shared export helpers live in @/lib/session-export ----------

function download(filename: string, content: string, type: string) {
  downloadText(filename, content, type);
}

function replayUrl(sessionId: string, url: string): string {
  try {
    const u = new URL(url);
    return `/api/replay/${sessionId}/${u.protocol.replace(":", "")}/${u.host}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function verdictStyle(v: ProbeResult["verdict"]): string {
  switch (v) {
    case "success":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/40";
    case "fail":
      return "bg-rose-500/15 text-rose-400 border-rose-500/40";
    default:
      return "bg-amber-500/15 text-amber-400 border-amber-500/40";
  }
}

function VerdictIcon({ v }: { v: ProbeResult["verdict"] }) {
  if (v === "success") return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (v === "fail") return <XCircle className="h-4 w-4 text-rose-400" />;
  return <HelpCircle className="h-4 w-4 text-amber-400" />;
}

function timeAgo(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "";
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Freshest cookies for a row: live server jar → fallback header → submitted cookies. */
async function freshRowCookies(row: ProbeResult, fallbackHeader = ""): Promise<ParsedCookie[]> {
  if (row.sessionId) {
    const j = await fetch(`/api/replay-cookies/${row.sessionId}`, { cache: "no-store" })
      .then((x) => x.json())
      .catch(() => null);
    if (j?.jar?.length) return j.jar as ParsedCookie[];
    if (j?.cookies) return parseCookieText(String(j.cookies)).cookies;
  }
  if (fallbackHeader) return parseCookieText(fallbackHeader).cookies;
  if (row.cookieSource) return parseCookieText(cookiePairsFromSource(row.cookieSource)).cookies;
  return [];
}

/** Combined per-row export: cookies (Netscape + header) and the nftoken link in one .txt. */
async function exportSessionTxt(row: ProbeResult, accessKey: string): Promise<string | null> {
  const cookies = await freshRowCookies(row);
  if (!cookies.length) return "No cookies captured for this row — run a check that captures cookies first.";
  const target = row.finalUrl || row.target;
  const host = hostOf(target);
  let nft: Nftoken = { link: "", kind: "magic", expires: null };
  let note = "";
  const got = await resolveNftoken(target, cookies, accessKey);
  if (got.ok) {
    nft = got.nft;
    if (got.note) note = got.note;
  } else {
    note = "nftoken could not be built: " + got.error;
  }
  const content = [
    "BRNT LoginProbe — session export",
    `Generated: ${new Date().toISOString()}`,
    `Target: ${target}`,
    `Username: ${row.username || ""}`,
    `Verdict: ${row.verdict} (confidence ${row.confidence})`,
    `Checked: ${row.checkedAt}`,
    "",
    "== nftoken link ==",
    `Type: ${
      nft.kind === "native"
        ? "native Netflix nftoken (works in ANY browser — no extension needed)"
        : "magic link BR1 (open it with the BRNT Cookie Bridge extension v1.2+)"
    }`,
    note ? `Note: ${note}` : null,
    nft.expires
      ? `Token expires: ${new Date(nft.expires * 1000).toISOString()}`
      : "Token expires: unknown (dies with the server-side session)",
    "",
    nft.link || "(unavailable)",
    "",
    "== cookies (Netscape cookies.txt) ==",
    toNetscape(cookies, host),
    "== cookies (header) ==",
    toHeader(cookies),
    "",
    "Warning: the nftoken link and these cookies grant full access to the logged-in session. Treat them like a password.",
  ]
    .filter((l) => l !== null)
    .join("\n");
  download(`brnt-session-${filePart(host)}.txt`, content, "text/plain");
  return null;
}

// ---------- results panel ----------

interface PanelProps {
  results: ProbeResult[];
  running: boolean;
  onClear: () => void;
  accessKey: string;
  /** admin-only: push a result row's cookies into the shared live panel */
  isAdmin?: boolean;
  onPushLive?: (p: {
    target: string;
    cookies: string;
    cookieObjs?: ParsedCookie[];
    sessionId?: string;
    label: string;
  }) => Promise<string | null>;
}

export function ResultsPanel({ results, running, onClear, accessKey, isAdmin, onPushLive }: PanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => results.find((r) => r.id === selectedId) || null, [results, selectedId]);
  const [bundleBusyId, setBundleBusyId] = useState<string | null>(null);
  const [bundleNote, setBundleNote] = useState("");
  const [pushBusyId, setPushBusyId] = useState<string | null>(null);
  const [pushedId, setPushedId] = useState<string | null>(null);
  const [pushNote, setPushNote] = useState("");

  function exportJson() {
    download("login-probe-results.json", JSON.stringify(results, null, 2), "application/json");
  }

  // Task 34: per-row "cookies + nftoken link" .txt for live/successful results
  async function exportRowBundle(r: ProbeResult) {
    setBundleBusyId(r.id);
    setBundleNote("");
    try {
      const err = await exportSessionTxt(r, accessKey);
      if (err) setBundleNote(err);
    } catch (e) {
      setBundleNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBundleBusyId(null);
    }
  }

  // Task 36: push a row straight into the live session box (right panel), no dialog needed
  async function pushRowLive(r: ProbeResult) {
    if (!onPushLive) return;
    setPushNote("");
    setPushBusyId(r.id);
    try {
      const cookies = await freshRowCookies(r);
      if (!cookies.length) {
        setPushNote("No cookies captured for this row — nothing to send to the live box.");
        return;
      }
      const err = await onPushLive({
        target: r.finalUrl || r.target,
        cookies: toHeader(cookies),
        cookieObjs: cookies,
        sessionId: r.sessionId || undefined,
        label: r.username && r.username !== "(cookie session)" ? r.username : "",
      });
      if (err) {
        setPushNote(`Live box push failed: ${err}`);
      } else {
        setPushedId(r.id);
        setTimeout(() => setPushedId((cur) => (cur === r.id ? null : cur)), 2500);
      }
    } catch (e) {
      setPushNote("Live box push failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setPushBusyId(null);
    }
  }

  function exportCsv() {
    const esc = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const head = "time,target,username,verdict,confidence,httpStatus,pageTitle,sessionId";
    const lines = results.map((r) =>
      [r.checkedAt, r.target, r.username, r.verdict, r.confidence, r.httpStatus ?? "", r.pageTitle ?? "", r.sessionId ?? ""]
        .map(esc)
        .join(",")
    );
    download("login-probe-results.csv", [head, ...lines].join("\n"), "text/csv");
  }

  return (
    <section aria-label="Results" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
          Results {results.length > 0 && <span className="text-zinc-500">({results.length})</span>}
        </h2>
        {results.length > 0 && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="border-zinc-800 text-zinc-300" onClick={exportJson}>
              <Download className="h-3.5 w-3.5" /> JSON
            </Button>
            <Button variant="outline" size="sm" className="border-zinc-800 text-zinc-300" onClick={exportCsv}>
              <Download className="h-3.5 w-3.5" /> CSV
            </Button>
            <Button variant="outline" size="sm" className="border-zinc-800 text-rose-400" onClick={onClear}>
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </Button>
          </div>
        )}
      </div>

      {running && (
        <p className="flex items-center gap-2 text-sm text-emerald-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking…
        </p>
      )}

      {bundleNote && (
        <p className="flex items-center gap-2 text-xs text-amber-400">
          <HelpCircle className="h-3.5 w-3.5" /> {bundleNote}
        </p>
      )}

      {pushNote && (
        <p className="flex items-center gap-2 text-xs text-amber-400">
          <HelpCircle className="h-3.5 w-3.5" /> {pushNote}
        </p>
      )}

      {results.length === 0 && !running && (
        <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
          No checks yet — run a single or bulk check and results appear here.
        </div>
      )}

      <ul className="space-y-2">
        {results.map((r) => {
          return (
            <li key={r.id} className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => setSelectedId(r.id)}
                className="min-w-0 flex-1 text-left rounded-lg border border-zinc-800 bg-zinc-950/60 hover:border-emerald-500/50 hover:bg-zinc-900/60 transition-colors p-3 flex flex-wrap items-center gap-x-3 gap-y-1"
              >
                <VerdictIcon v={r.verdict} />
                <Badge variant="outline" className={`uppercase text-[10px] font-bold tracking-wide ${verdictStyle(r.verdict)}`}>
                  {r.verdict}
                </Badge>
                <span className="font-mono text-sm text-zinc-200 truncate max-w-[240px]">{hostOf(r.target)}</span>
                <span className="text-xs text-zinc-400 truncate max-w-[180px]">{r.username}</span>
                {r.pageTitle && <span className="text-xs text-zinc-500 truncate hidden sm:inline max-w-[220px]">{r.pageTitle}</span>}
                <span className="ml-auto text-[11px] text-zinc-500">{timeAgo(r.checkedAt)}</span>
              </button>
              {r.verdict === "success" && (
                <button
                  type="button"
                  onClick={() => exportRowBundle(r)}
                  disabled={bundleBusyId === r.id}
                  title="Download this live result — cookies + nftoken link (.txt)"
                  aria-label="Download cookies and nftoken link (.txt)"
                  className="shrink-0 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
                >
                  {bundleBusyId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                </button>
              )}
              {r.verdict === "success" && isAdmin && onPushLive && (
                <button
                  type="button"
                  onClick={() => pushRowLive(r)}
                  disabled={pushBusyId === r.id}
                  title="Send to the live session box (right panel)"
                  aria-label="Send to live session box"
                  className="shrink-0 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 text-sky-400 hover:bg-sky-500/20 disabled:opacity-50 transition-colors"
                >
                  {pushBusyId === r.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : pushedId === r.id ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <Radio className="h-4 w-4" />
                  )}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {selected && (
        <ResultDialog
          row={selected}
          accessKey={accessKey}
          isAdmin={isAdmin}
          onPushLive={onPushLive}
          onClose={() => setSelectedId(null)}
        />
      )}
    </section>
  );
}

// ---------- result dialog ----------

interface DialogProps {
  row: ProbeResult;
  accessKey: string;
  isAdmin?: boolean;
  onPushLive?: (p: {
    target: string;
    cookies: string;
    cookieObjs?: ParsedCookie[];
    sessionId?: string;
    label: string;
  }) => Promise<string | null>;
  onClose: () => void;
}

function ResultDialog({ row: r, accessKey, isAdmin, onPushLive, onClose }: DialogProps) {
  const [jarCookies, setJarCookies] = useState<string>(""); // header string from server jar
  const [jarAlive, setJarAlive] = useState<boolean | null>(null);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState("");
  const [showCookies, setShowCookies] = useState(false);
  const [magic, setMagic] = useState<MagicLink | null>(null);
  const [magicBusy, setMagicBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState("");
  const [nf, setNf] = useState<{ busy: boolean; link: string | null; expires: number | null; error: string | null }>({
    busy: false,
    link: null,
    expires: null,
    error: null,
  });

  const previewUrl = r.sessionId ? replayUrl(r.sessionId, r.finalUrl || r.target) : null;

  // Task 29/34: native nftoken minting is Netflix-specific
  const isNetflixTarget = useMemo(() => isNetflixHost(r.finalUrl || r.target), [r.finalUrl, r.target]);

  // jar cookies on open
  useEffect(() => {
    let cancelled = false;
    if (r.sessionId) {
      fetch(`/api/replay-cookies/${r.sessionId}`, { cache: "no-store" })
        .then((x) => x.json())
        .then((j) => {
          if (cancelled) return;
          setJarAlive(Boolean(j.alive));
          if (j.cookies) setJarCookies(j.cookies);
        })
        .catch(() => setJarAlive(false));
    }
    return () => {
      cancelled = true;
    };
  }, [r.sessionId]);

  const displayCookies: { label: string; pairs: string } = useMemo(() => {
    if (jarCookies) return { label: "session jar", pairs: jarCookies };
    if (r.cookieSource) {
      const header = cookiePairsFromSource(r.cookieSource);
      return { label: "submitted cookies", pairs: header };
    }
    return { label: "", pairs: "" };
  }, [jarCookies, r.cookieSource]);

  const parsedDisplay: ParsedCookie[] = useMemo(
    () => (displayCookies.pairs ? parseCookieText(displayCookies.pairs).cookies : []),
    [displayCookies.pairs]
  );

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      window.prompt("Copy manually:", text);
    }
  }

  // ---- nftoken flows (Task 34): open / show / download ----

  /** Freshest cookie source for this row: live jar → loaded jar → submitted cookies. */
  async function freshCookieSource(): Promise<ParsedCookie[]> {
    return freshRowCookies(r, jarCookies);
  }

  // NATIVE Netflix token minted by Netflix's iOS API from NetflixId (Task 29/31).
  // With open=true this is the ONE-CLICK login: a placeholder tab is opened
  // synchronously inside the click gesture (popup-blocker safe), the token is
  // minted server-side, then the tab navigates to the native link — Netflix's
  // own server validates it and signs the visitor in. No extension needed.
  // With fallbackToMagic=true a failed native mint falls back to the BR1 magic
  // link (needs the Cookie Bridge extension to open).
  async function mintNative(
    open: boolean,
    fallbackToMagic = false
  ): Promise<Nftoken | null> {
    setMsg("");
    setNf({ busy: true, link: null, expires: null, error: null });
    const w = open ? window.open("", "_blank") : null;
    if (w) {
      try {
        w.document.write(
          '<p style="font:14px/1.6 system-ui,sans-serif;padding:28px;color:#555">Minting your Netflix login link…</p>'
        );
      } catch {
        /* ignore */
      }
    }
    const fail = (error: string): Nftoken | null => {
      if (w) w.close();
      setNf({ busy: false, link: null, expires: null, error });
      return null;
    };
    try {
      const cookies = await freshCookieSource();
      if (!cookies.length) {
        return fail("No cookies available for this row — run a check that captures cookies first.");
      }
      const res = await fetch("/api/nftoken", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brnt-access": accessKey },
        body: JSON.stringify({ jar: cookies }),
      });
      const j = await res.json().catch(() => null);
      const link = res.ok && j?.ok && j.link ? String(j.link) : null;
      if (link) {
        const expires = Number.isFinite(j.expires) ? Number(j.expires) : null;
        setNf({ busy: false, link, expires, error: null });
        copy(link, "nf");
        if (w) {
          w.location.href = link;
        } else if (open) {
          // placeholder tab was popup-blocked — try once directly
          const w2 = window.open(link, "_blank");
          if (!w2) setMsg("Popup blocked — the link is copied; open it in the address bar to log in.");
        }
        return { link, kind: "native", expires };
      }
      const why = String(j?.message || j?.error || `HTTP ${res.status}`);
      if (fallbackToMagic) {
        const built = await makeMagicLink();
        if (w) w.close();
        setNf({ busy: false, link: null, expires: null, error: null });
        if (built) {
          setMsg(`Native mint failed (${why}) — magic link used instead. Opening it needs the Cookie Bridge extension.`);
          if (open) window.open(built.link, "_blank", "noopener");
          return { link: built.link, kind: "magic", expires: null };
        }
        return null;
      }
      return fail(why);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  // Netflix-style magic link: https://site/?nftoken=<encoded cookie payload>
  async function makeMagicLink(): Promise<MagicLink | null> {
    setMsg("");
    setMagicBusy(true);
    try {
      const cookies = await freshCookieSource();
      if (!cookies.length) {
        setMsg("No cookies available for this row — run a check that captures cookies first.");
        return null;
      }
      const built = await buildMagicLink(r.finalUrl || r.target, cookies);
      setMagic(built);
      copy(built.link, "magic");
      return built;
    } catch (e) {
      setMsg("Could not build the magic link: " + (e instanceof Error ? e.message : String(e)));
      return null;
    } finally {
      setMagicBusy(false);
    }
  }

  /** Mint (if needed) and reveal the nftoken link box. */
  async function showNftoken(): Promise<Nftoken | null> {
    if (isNetflixTarget) return mintNative(false, true);
    const built = await makeMagicLink();
    return built ? { link: built.link, kind: "magic", expires: null } : null;
  }

  /** Open the real site via a freshly minted nftoken — the one-click login. */
  async function openWithNftoken() {
    if (isNetflixTarget) {
      await mintNative(true, true);
      return;
    }
    // Non-Netflix: same placeholder-tab pattern as the Netflix native path —
    // the tab opens synchronously inside the click gesture (the popup blocker
    // can't kill it), then navigates to the magic link once it is built.
    setMsg("");
    setMagicBusy(true);
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
      const cookies = await freshCookieSource();
      if (!cookies.length) {
        w?.close();
        setMsg("No cookies available for this row — run a check that captures cookies first.");
        return;
      }
      const built = await buildMagicLink(r.finalUrl || r.target, cookies);
      setMagic(built);
      copy(built.link, "magic");
      if (w) {
        w.location.href = built.link;
      } else {
        const w2 = window.open(built.link, "_blank", "noopener");
        if (!w2) setMsg("Popup blocked — the link is copied; open it in the address bar to log in.");
      }
    } catch (e) {
      w?.close();
      setMsg("Could not build the magic link: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setMagicBusy(false);
    }
  }

  /** Admin: push this row's freshest cookies into the shared live panel. */
  async function pushToLive() {
    if (!onPushLive) return;
    setPushMsg("");
    setPushBusy(true);
    try {
      const cookies = await freshCookieSource();
      if (!cookies.length) {
        setPushMsg("No cookies available for this row — nothing to push.");
        return;
      }
      const err = await onPushLive({
        target: r.finalUrl || r.target,
        cookies: toHeader(cookies),
        cookieObjs: cookies,
        sessionId: r.sessionId || undefined,
        label: r.username && r.username !== "(cookie session)" ? r.username : "",
      });
      setPushMsg(err ? `Push failed: ${err}` : "Added to the live panel ✓");
    } catch (e) {
      setPushMsg("Push failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setPushBusy(false);
    }
  }

  function dlCookiesTxt() {
    if (!parsedDisplay.length) {
      setMsg("No cookies available for this row — run a check that captures cookies first.");
      return;
    }
    const host = hostOf(r.finalUrl || r.target);
    download(`brnt-cookies-${filePart(host)}.txt`, toNetscape(parsedDisplay, host), "text/plain");
  }

  async function dlNftokenTxt() {
    setMsg("");
    const existing = nf.link
      ? { link: nf.link, kind: "native" as const, expires: nf.expires }
      : magic && !isNetflixTarget
        ? { link: magic.link, kind: "magic" as const, expires: null }
        : null;
    const got = existing || (await showNftoken());
    if (!got) return; // error already surfaced by the mint helpers
    download(
      `brnt-nftoken-${filePart(hostOf(r.finalUrl || r.target))}.txt`,
      nftokenTxtFor(got, r.finalUrl || r.target, r.username),
      "text/plain"
    );
  }

  const dialogTitle = r.username === "(cookie session)" ? hostOf(r.target) : r.username;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[92svh] w-full flex-col gap-0 overflow-hidden border-zinc-800 bg-zinc-950 p-0 text-zinc-100 sm:max-w-2xl">
        <DialogHeader className="shrink-0 gap-1.5 border-b border-zinc-800 px-5 pb-3 pr-12 pt-4 text-left">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <VerdictIcon v={r.verdict} />
            <span className="truncate">{dialogTitle}</span>
            <Badge variant="outline" className={`uppercase text-[10px] font-bold ${verdictStyle(r.verdict)}`}>
              {r.verdict} · {r.confidence}
            </Badge>
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-zinc-400 break-all">
            {r.target}
          </DialogDescription>
        </DialogHeader>

        <div className="dialog-body min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-4">
          {/* cookies — hidden by default, revealed with the See cookies button (Task 34) */}
          <div className="rounded-lg border border-zinc-800 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                Cookies{displayCookies.label && <span className="text-zinc-600 normal-case"> ({displayCookies.label})</span>}
                {parsedDisplay.length > 0 && <span className="text-zinc-600 normal-case"> · {parsedDisplay.length}</span>}
              </h3>
              {parsedDisplay.length > 0 && (
                <Button variant="outline" size="sm" className="h-7 border-zinc-800 text-zinc-300"
                  onClick={() => setShowCookies((v) => !v)}>
                  {showCookies ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  {showCookies ? "Hide cookies" : "See cookies"}
                </Button>
              )}
            </div>
            {parsedDisplay.length > 0 ? (
              showCookies ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {parsedDisplay.map((c, i) => (
                      <span key={`${c.name}-${i}`} className="rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
                        {c.name}=<span className="text-zinc-500">{c.value.slice(0, 10)}…</span>
                      </span>
                    ))}
                  </div>
                  <pre className="max-h-48 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-zinc-300">
                    {parsedDisplay.map((c) => `${c.name}=${c.value}`).join("\n")}
                  </pre>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" className="h-7 border-zinc-800 text-zinc-300"
                      onClick={() => copy(displayCookies.pairs, "header")}>
                      <Copy className="h-3 w-3" /> {copied === "header" ? "Copied" : "Copy header"}
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 border-zinc-800 text-zinc-300"
                      onClick={() => copy(JSON.stringify(parsedDisplay, null, 2), "json")}>
                      <Copy className="h-3 w-3" /> {copied === "json" ? "Copied" : "Copy Cookie-Editor JSON"}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-zinc-500">
                  {parsedDisplay.length} cookie(s) captured — click <b className="text-zinc-400">See cookies</b> to view the full values.
                </p>
              )
            ) : (
              <p className="text-xs text-zinc-500">No cookies recorded for this row.</p>
            )}
          </div>

          {/* actions (Task 34): nftoken-first, no extension flow */}
          <div className="space-y-2">
            <Button
              onClick={openWithNftoken}
              disabled={magicBusy || nf.busy}
              className={`w-full h-12 text-base font-bold ${
                isNetflixTarget ? "bg-red-600 hover:bg-red-700 text-white" : "bg-emerald-500 hover:bg-emerald-600 text-emerald-950"
              }`}
            >
              {magicBusy || nf.busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Ticket className="h-5 w-5" />}
              {isNetflixTarget ? "Open Netflix with nftoken — one-click login" : "Open site with nftoken"}
            </Button>
            <Button
              onClick={showNftoken}
              disabled={magicBusy || nf.busy}
              variant="outline"
              className="w-full h-10 border-fuchsia-500/50 text-fuchsia-400 hover:bg-fuchsia-500/10"
            >
              {magicBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              Show nftoken link
            </Button>
            <div className="flex gap-2">
              <Button
                onClick={dlCookiesTxt}
                disabled={!parsedDisplay.length}
                variant="outline"
                className="flex-1 h-10 border-zinc-800 text-zinc-300 hover:bg-zinc-900"
              >
                <Download className="h-4 w-4" /> Download cookies (.txt)
              </Button>
              <Button
                onClick={dlNftokenTxt}
                disabled={magicBusy || nf.busy}
                variant="outline"
                className="flex-1 h-10 border-zinc-800 text-zinc-300 hover:bg-zinc-900"
              >
                <Download className="h-4 w-4" /> Download nftoken (.txt)
              </Button>
            </div>
            {isAdmin && onPushLive && (
              <div className="space-y-1">
                <Button
                  onClick={pushToLive}
                  disabled={pushBusy}
                  variant="outline"
                  className="w-full h-9 border-sky-500/50 text-sky-400 hover:bg-sky-500/10"
                >
                  {pushBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
                  Add to live panel (admin)
                </Button>
                {pushMsg && (
                  <p className={`text-xs ${pushMsg.includes("failed") || pushMsg.includes("No cookies") ? "text-amber-400" : "text-emerald-400"}`}>
                    {pushMsg}
                  </p>
                )}
              </div>
            )}
          </div>

          {magic && (
            <div className="rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/5 p-3 space-y-2">
              <p className="flex items-center gap-1.5 text-xs font-bold text-fuchsia-400">
                <Link2 className="h-3.5 w-3.5" /> Magic link — opens the real site logged-in
              </p>
              <p className="text-[11px] leading-relaxed text-zinc-400">
                Same shape as Netflix&apos;s <span className="font-mono">?nftoken=</span> links: the session cookies
                travel inside the URL. Anyone with the <b>BRNT Cookie Bridge</b> extension (v1.2+) who opens it gets
                the cookies applied, the token stripped and the site reloaded — logged in. Treat this link like a
                password: it dies when the session dies.
              </p>
              <div className="max-h-24 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] break-all text-zinc-300">
                {magic.link}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="h-7 border-zinc-800 text-zinc-300"
                  onClick={() => copy(magic.link, "magic")}>
                  <Copy className="h-3 w-3" /> {copied === "magic" ? "Copied" : "Copy link"}
                </Button>
                {"share" in navigator && (
                  <Button size="sm" variant="outline" className="h-7 border-fuchsia-500/50 text-fuchsia-400"
                    onClick={() => navigator.share({ title: "Logged-in session", url: magic.link }).catch(() => {})}>
                    <Share2 className="h-3 w-3" /> Share…
                  </Button>
                )}
                <span className="ml-auto text-[11px] text-zinc-500">
                  {magic.count} cookies · {magic.encoded} · {magic.link.length.toLocaleString()} chars
                </span>
              </div>
            </div>
          )}

          {nf.link && (
            <div className="rounded-lg border border-red-600/40 bg-red-600/5 p-3 space-y-2">
              <p className="flex items-center gap-1.5 text-xs font-bold text-red-400">
                <Ticket className="h-3.5 w-3.5" /> Native nftoken — works in ANY browser, no extension
              </p>
              <p className="text-[11px] leading-relaxed text-zinc-400">
                Minted by Netflix&apos;s iOS API from this session&apos;s <span className="font-mono">NetflixId</span>.
                Opening it makes Netflix itself sign the visitor in (it sets the session cookies server-side).
                Netflix rotates the token after use — the link may work only once; mint a fresh one any time while
                the session stays alive. Treat it like a password.
              </p>
              <div className="max-h-24 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] break-all text-zinc-300">
                {nf.link}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="h-7 border-zinc-800 text-zinc-300"
                  onClick={() => copy(nf.link!, "nf")}>
                  <Copy className="h-3 w-3" /> {copied === "nf" ? "Copied" : "Copy link"}
                </Button>
                {"share" in navigator && (
                  <Button size="sm" variant="outline" className="h-7 border-red-600/50 text-red-400"
                    onClick={() => navigator.share({ title: "Netflix login link", url: nf.link! }).catch(() => {})}>
                    <Share2 className="h-3 w-3" /> Share…
                  </Button>
                )}
                <span className="ml-auto text-[11px] text-zinc-500">
                  {nf.expires
                    ? `token expires ${new Date(nf.expires * 1000).toLocaleString()}`
                    : "expiry unknown"}
                </span>
              </div>
            </div>
          )}
          {nf.error && (
            <p className="text-xs text-amber-400">nftoken: {nf.error}</p>
          )}

          {msg && (
            <p className={`text-xs ${msg.includes("fail") || msg.includes("No cookies") || msg.includes("Could not") ? "text-amber-400" : "text-emerald-400"}`}>
              {msg}
            </p>
          )}

          {/* replay preview (kept below the actions — Task 34) */}
          {previewUrl && (
            <div className="space-y-1.5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                Logged-in preview {jarAlive === false && <span className="text-amber-500 normal-case">(session expired — re-run the check to refresh it)</span>}
              </h3>
              <div className="rounded-lg overflow-hidden border border-zinc-800">
                <iframe
                  src={previewUrl}
                  title="Logged-in preview"
                  className="w-full h-56 bg-white sm:h-64"
                  referrerPolicy="no-referrer"
                />
              </div>
            </div>
          )}

          {/* evidence (collapsible so the full box stays visible) */}
          <details className="rounded-lg border border-zinc-800 px-3 py-2">
            <summary className="cursor-pointer select-none text-xs font-bold uppercase tracking-wider text-zinc-400">
              Evidence{(r.evidence || []).length > 0 && <span className="normal-case text-zinc-600"> ({(r.evidence || []).length})</span>}
            </summary>
            <ul className="mt-2 space-y-1">
              {(r.evidence || []).map((e, i) => (
                <li key={i} className="font-mono text-[11px] break-words text-zinc-400">· {e}</li>
              ))}
            </ul>
            {r.pageTitle && <p className="mt-1 text-[11px] text-zinc-500">Page title: {r.pageTitle}</p>}
          </details>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
