"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Puzzle,
  ShieldAlert,
  Cookie as CookieIcon,
} from "lucide-react";
import type { ProbeResult } from "@/lib/probe-types";
import { callCheckApi } from "@/lib/probe-client";
import {
  cookieEditorExport,
  cookieHeaderFromPairs,
  cookiePairsFromSource,
  netscapeExport,
  type CookiePair,
} from "@/lib/cookie-file";
import {
  buildApplyPayload,
  parseSourceCookies,
  postApplyCookies,
  useBrntExtension,
} from "@/lib/cookie-apply";
import { replaceResult } from "@/lib/results-store";

/**
 * Open-the-original-site handoff.
 *
 * Clicking a successful result launches THE ORIGINAL WEBSITE LINK in a new
 * tab. Browsers forbid one site from planting another site's cookies, so this
 * page finishes the job — two ways:
 *
 *   AUTOMATIC (BRNT Cookie Importer extension installed): the resolved
 *   cookies are handed to the extension over postMessage; it plants them on
 *   the site's own domain through the privileged chrome.cookies API, this tab
 *   then navigates to the ORIGINAL url — logged in, zero pasting.
 *
 *   MANUAL fallback (no extension): clipboard copy + Cookie-Editor JSON /
 *   cookies.txt downloads + one-paste instructions, then redirect.
 *
 * Cookie resolution order: stored cookieSource → live server session jar →
 * a fresh credential re-login.
 */

type State =
  | { phase: "loading" }
  | { phase: "not-found" }
  | {
      phase: "ready";
      row: ProbeResult;
      pairs: CookiePair[];
      source: string;
      originalUrl: string;
      note: string | null;
    };

function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure/blocked contexts
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export default function OpenHandoff({ resultId }: { resultId: string }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [copied, setCopied] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const redirecting = useRef(false);
  // --- automated import (extension) state ---
  const extDetected = useBrntExtension();
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  const [applyErrors, setApplyErrors] = useState<string[]>([]);
  const [applyPending, setApplyPending] = useState(false);
  const autoTried = useRef(false);

  const go = useCallback((url: string) => {
    if (redirecting.current) return;
    redirecting.current = true;
    window.location.replace(url);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let row: ProbeResult | undefined;
      try {
        const raw = window.localStorage.getItem("login-probe-results");
        const list = raw ? (JSON.parse(raw) as ProbeResult[]) : [];
        row = list.find((r) => r && r.id === resultId);
      } catch {
        row = undefined;
      }
      if (!row) {
        if (!cancelled) setState({ phase: "not-found" });
        return;
      }

      const originalUrl = row.finalUrl || row.target;
      let pairs: CookiePair[] = [];
      let source = "";
      let note: string | null = null;

      // 1) Cookies pasted/uploaded with the check — the source of truth.
      const stored = row.cookieSource?.trim() ?? "";
      if (stored) {
        pairs = cookiePairsFromSource(stored);
        source = "stored with this result";
      }

      // 2) Credential logins keep their jar on the server — that IS the
      //    cookies that were used.
      if (pairs.length === 0 && row.sessionId) {
        try {
          const res = await fetch(`/api/replay-cookies/${row.sessionId}`, {
            cache: "no-store",
          });
          const data = (await res.json()) as { alive?: boolean; cookies?: string };
          if (data.alive && data.cookies) {
            pairs = cookiePairsFromSource(data.cookies);
            source = "from the live session on the server";
          }
        } catch {
          /* fall through */
        }
      }

      // 3) Nothing stored survives — re-run the check with the row's own
      //    credentials to mint a fresh session, then take its jar.
      if (
        pairs.length === 0 &&
        row.username.trim() !== "" &&
        row.username !== "(cookie session)" &&
        row.password !== ""
      ) {
        const next = await callCheckApi({
          url: row.target,
          username: row.username,
          password: row.password,
        });
        replaceResult(row.id, next);
        row = next;
        if (next.verdict === "success" && next.sessionId) {
          try {
            const res = await fetch(`/api/replay-cookies/${next.sessionId}`, {
              cache: "no-store",
            });
            const data = (await res.json()) as { alive?: boolean; cookies?: string };
            if (data.alive && data.cookies) {
              pairs = cookiePairsFromSource(data.cookies);
              source = "fresh login just now";
            }
          } catch {
            /* ignore */
          }
          note = "The stored session was gone — the check was re-run automatically and the fresh cookies are below.";
        }
      }

      if (cancelled) return;
      setState({ phase: "ready", row, pairs, source, originalUrl, note });

      // Best-effort silent copy — browsers without a user gesture (Safari) will
      // reject; the big button below covers that with a real tap.
      if (pairs.length > 0) {
        const ok = await copyText(cookieHeaderFromPairs(pairs));
        if (!cancelled && ok) {
          setCopied(true);
          setCountdown(5);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resultId]);

  // Countdown → auto-redirect to the ORIGINAL site.
  useEffect(() => {
    if (countdown === null || state.phase !== "ready") return;
    if (countdown <= 0) {
      go(state.originalUrl);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, state, go]);

  const copyAndOpen = async () => {
    if (state.phase !== "ready") return;
    if (state.pairs.length > 0) {
      const ok = await copyText(cookieHeaderFromPairs(state.pairs));
      setCopied(ok);
    }
    go(state.originalUrl);
  };

  if (state.phase === "loading") {
    return (
      <Centered>
        <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        <p className="mt-3 text-sm text-zinc-400">
          Resolving the cookies used for this target…
        </p>
      </Centered>
    );
  }

  if (state.phase === "not-found") {
    return (
      <Centered>
        <ShieldAlert className="h-8 w-8 text-amber-400" />
        <h1 className="mt-3 text-lg font-semibold text-zinc-100">
          Result not found in this browser
        </h1>
        <p className="mt-2 max-w-md text-center text-sm text-zinc-400">
          Results live in the browser that ran the check. Open the BRNT console in
          that browser and click the target there — its cookies will be handed over
          the same way.
        </p>
        <Button asChild variant="outline" className="mt-4">
          <a href="/">Back to LoginProbe</a>
        </Button>
      </Centered>
    );
  }

  const { row, pairs, source, originalUrl, note } = state;
  const site = hostOf(originalUrl);
  const headerStr = cookieHeaderFromPairs(pairs);

  return (
    <Centered>
      <div className="w-full max-w-xl space-y-4 rounded-2xl border border-white/10 bg-black/45 p-5 shadow-2xl backdrop-blur-xl sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
              <CookieIcon className="h-5 w-5 text-emerald-400" />
              {pairs.length > 0 ? "Cookies ready" : "No cookies for this row"}
            </h1>
            <p className="mt-1 break-all font-mono text-xs text-zinc-400">{originalUrl}</p>
          </div>
          <Badge
            variant="outline"
            className={
              row.verdict === "success"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-amber-500/40 bg-amber-500/10 text-amber-300"
            }
          >
            {row.verdict}
          </Badge>
        </div>

        {note && (
          <p className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-2.5 text-xs text-sky-200">
            {note}
          </p>
        )}

        {pairs.length > 0 ? (
          <>
            <div
              className={`rounded-xl border p-3 text-sm ${
                copied
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : "border-white/10 bg-white/5 text-zinc-300"
              }`}
            >
              {copied ? (
                <p className="flex items-center gap-2 font-semibold">
                  <Check className="h-4 w-4" />
                  {pairs.length} cookie{pairs.length === 1 ? "" : "s"} copied to your
                  clipboard
                </p>
              ) : (
                <p>
                  <b>{pairs.length}</b> cookie{pairs.length === 1 ? "" : "s"} resolved
                  ({source}) — tap the green button to copy them.
                </p>
              )}
              {!copied && (
                <Button
                  onClick={() => void copyAndOpen()}
                  className="mt-3 w-full whitespace-normal bg-emerald-500 text-sm font-extrabold leading-tight text-black shadow-lg shadow-emerald-500/40 ring-1 ring-emerald-300/60 hover:bg-emerald-400 sm:text-base"
                >
                  Copy cookies &amp; open {site}{" "}
                  <ExternalLink className="ml-1.5 inline h-5 w-5 shrink-0" strokeWidth={2.5} />
                </Button>
              )}
            </div>

            {countdown !== null && countdown > 0 && (
              <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
                Opening <b className="font-mono">{site}</b> in {countdown}s…
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copyAndOpen()}
                >
                  Open now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCountdown(null)}
                >
                  Stay here
                </Button>
              </p>
            )}

            <ol className="space-y-1.5 rounded-xl border border-white/10 bg-white/5 p-3 text-xs leading-relaxed text-zinc-300">
              <li>
                <b className="text-zinc-100">1.</b> The original site opens in this
                tab (automatic once cookies are copied).
              </li>
              <li>
                <b className="text-zinc-100">2.</b> On the site, open the{" "}
                <b>Cookie-Editor</b> extension (Chrome/Edge/Firefox; on Android use
                Firefox or Kiwi) → <b>Import</b>.
              </li>
              <li>
                <b className="text-zinc-100">3.</b> Paste (Ctrl/Cmd+V) → Import →
                refresh the page — the account is logged in.
              </li>
            </ol>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadText(
                    `cookies-${site.replace(/[^\w.-]/g, "_")}.json`,
                    cookieEditorExport(pairs, row.target),
                    "application/json",
                  )
                }
              >
                <Download className="mr-1.5 h-4 w-4" /> Cookie-Editor JSON
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadText(
                    `cookies-${site.replace(/[^\w.-]/g, "_")}.txt`,
                    netscapeExport(pairs, row.target),
                    "text/plain",
                  )
                }
              >
                <Download className="mr-1.5 h-4 w-4" /> cookies.txt
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void copyText(headerStr).then(setCopied)}
              >
                {copied ? (
                  <>
                    Copied! <Check className="ml-1 h-3.5 w-3.5" />
                  </>
                ) : (
                  <>
                    Copy again <Copy className="ml-1 h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            </div>

            <details className="rounded-lg border border-white/10 bg-black/25 p-2.5">
              <summary className="cursor-pointer text-xs font-semibold text-emerald-200">
                Show the {pairs.length} cookies used
              </summary>
              <ul className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto font-mono text-[11px] text-emerald-100/90">
                {pairs.map((p) => (
                  <li key={p.name} className="break-all rounded bg-white/5 px-1.5 py-0.5">
                    <b>{p.name}</b> = {p.value}
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <div className="space-y-3 text-sm text-zinc-300">
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              This row has no stored cookies and no credentials to re-apply them
              from. The site will open normally (logged out).
            </p>
            <Button
              onClick={() => go(originalUrl)}
              className="w-full whitespace-normal bg-emerald-500 text-sm font-extrabold leading-tight text-black shadow-lg shadow-emerald-500/40 hover:bg-emerald-400 sm:text-base"
            >
              Open {site} anyway{" "}
              <ExternalLink className="ml-1.5 inline h-5 w-5 shrink-0" strokeWidth={2.5} />
            </Button>
          </div>
        )}

        <p className="text-[11px] leading-snug text-zinc-500">
          Browsers never let one website place another site&apos;s cookies — so the
          values are handed over here and imported with one paste. They stay on
          your device.
        </p>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      {children}
    </main>
  );
}
