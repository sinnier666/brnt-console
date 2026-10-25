"use client";

import { useCallback, useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KeyRound, Loader2, ShieldCheck, Copy, ChevronDown, ShieldAlert, Puzzle, LogOut, Radio } from "lucide-react";
import type { ProbeResult } from "@/lib/probe-types";
import type { ParsedCookie } from "@/lib/cookies";
import { SingleCheckForm } from "./single-check-form";
import { BulkCheckForm } from "./bulk-check-form";
import { ResultsPanel } from "./results-panel";
import { LivePanel } from "./live-panel";
import { addLocalLive } from "@/lib/local-live";
import { WallpaperButton, useWallpaper } from "./wallpaper-picker";

const RESULTS_KEY = "login-probe-results";
const CONFIRMED_KEY = "brnt-confirmed";
const ACCESS_KEY = "brnt-access-key";
const ADMIN_KEY_STORAGE = "brnt-admin-key";

interface AccessRecord {
  code: string;
  days: number;
  note: string;
  createdAt: string;
  expiresAt: string;
}

export function LoginProbeApp() {
  // results
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [running, setRunning] = useState(false);

  // gate
  const [confirmed, setConfirmed] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [accessRecord, setAccessRecord] = useState<AccessRecord | null>(null);
  const [validating, setValidating] = useState(true);
  const [gateError, setGateError] = useState("");
  const [gateOpen, setGateOpen] = useState(true);
  const [showAdmin, setShowAdmin] = useState(false);
  const [mintAdminInput, setMintAdminInput] = useState("");
  const [adminDays, setAdminDays] = useState(3);
  const [mintBusy, setMintBusy] = useState(false);
  const [minted, setMinted] = useState<AccessRecord | null>(null);
  const [copied, setCopied] = useState("");

  // built-in codes (50 permanent accounts) — fetched admin-gated on demand
  const [builtinCodes, setBuiltinCodes] = useState<string[]>([]);
  const [builtinOpen, setBuiltinOpen] = useState(false);
  const [builtinBusy, setBuiltinBusy] = useState(false);
  const [builtinErr, setBuiltinErr] = useState("");

  // admin (live panel management) — verified against the server, kept in session storage
  const [adminKey, setAdminKey] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [liveTick, setLiveTick] = useState(0);

  // wallpaper
  const [wall, setWall] = useWallpaper();

  // shared form state
  const [mode, setMode] = useState("single");
  const [loginUrl, setLoginUrl] = useState("");
  const [urlLocked, setUrlLocked] = useState(false);
  const [sharedCookies, setSharedCookies] = useState("");

  // hydrate
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RESULTS_KEY);
      if (raw) setResults(JSON.parse(raw));
      setConfirmed(localStorage.getItem(CONFIRMED_KEY) === "1");
      const k = localStorage.getItem(ACCESS_KEY) || "";
      setAccessKey(k);
      if (k) {
        validate(k);
      } else {
        setValidating(false);
      }
      const ak = sessionStorage.getItem(ADMIN_KEY_STORAGE) || "";
      if (ak) verifyAdmin(ak, true);
    } catch {
      setValidating(false);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(RESULTS_KEY, JSON.stringify(results));
    } catch {
      /* quota */
    }
  }, [results]);

  const validate = useCallback(async (code: string): Promise<boolean> => {
    setValidating(true);
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "validate", code }),
      });
      if (res.ok) {
        const j = await res.json();
        setAccessRecord(j.record || null);
        setGateOpen(false);
        setGateError("");
        return true;
      }
      setAccessRecord(null);
      setGateOpen(true);
      setGateError("Key invalid or expired.");
      return false;
    } catch {
      setAccessRecord(null);
      setGateOpen(true);
      setGateError("Could not reach the access server.");
      return false;
    } finally {
      setValidating(false);
    }
  }, []);

  function onResult(r: ProbeResult) {
    setResults((prev) => [r, ...prev].slice(0, 500));
  }

  /** Verify an admin key against the server; null = ok, string = error. */
  async function verifyAdmin(key: string, silent = false): Promise<string | null> {
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "admin-verify", adminKey: key }),
      });
      if (res.ok) {
        setIsAdmin(true);
        setAdminKey(key);
        try {
          sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
        } catch {}
        return null;
      }
      lockAdmin();
      return silent ? null : "Invalid admin key.";
    } catch {
      return silent ? null : "Could not reach the server.";
    }
  }

  function lockAdmin() {
    setIsAdmin(false);
    setAdminKey("");
    try {
      sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    } catch {}
  }

  /** Forget the member key on this device (gate reopens). */
  function lockMember() {
    setAccessKey("");
    setAccessRecord(null);
    setGateOpen(true);
    try {
      localStorage.removeItem(ACCESS_KEY);
    } catch {}
  }

  /** Admin: push a result row's cookies into the shared live panel (live session box).
   * If the server pool can't save (e.g. Netlify Blobs write failure), the session
   * falls back to THIS DEVICE's local live pool so the panel keeps working. */
  async function pushLive(p: {
    target: string;
    cookies: string;
    cookieObjs?: ParsedCookie[];
    sessionId?: string;
    label: string;
  }): Promise<string | null> {
    let serverError: string;
    try {
      const res = await fetch("/api/live-sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brnt-admin": adminKey },
        body: JSON.stringify(p),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok) {
        setLiveTick((t) => t + 1);
        return null;
      }
      serverError = String(j?.error || j?.message || `HTTP ${res.status}`);
    } catch (e) {
      serverError = e instanceof Error ? e.message : String(e);
    }
    // Server pool unavailable — keep the session on this device.
    const local = addLocalLive({
      target: p.target,
      label: p.label,
      cookieHeader: p.cookies,
      cookies: p.cookieObjs,
    });
    if (local) {
      setLiveTick((t) => t + 1);
      return `Server pool unavailable (${serverError}) — session saved to THIS DEVICE's live panel instead.`;
    }
    return serverError;
  }

  async function mint() {
    setMintBusy(true);
    setMinted(null);
    setGateError("");
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "generate", adminKey: mintAdminInput || adminKey, days: adminDays }),
      });
      const j = await res.json();
      if (res.ok && j.ok && j.record) {
        setMinted(j.record);
        setMintAdminInput("");
      } else {
        setGateError(j.error || "Key generation failed.");
      }
    } catch {
      setGateError("Could not reach the access server.");
    } finally {
      setMintBusy(false);
    }
  }

  async function loadBuiltin() {
    const key = mintAdminInput || adminKey;
    if (!key.trim()) {
      setBuiltinErr("Enter the admin key above first.");
      return;
    }
    setBuiltinBusy(true);
    setBuiltinErr("");
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list-builtin", adminKey: key }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok && Array.isArray(j.codes)) {
        setBuiltinCodes(j.codes);
        setBuiltinOpen(true);
      } else {
        setBuiltinErr(String(j?.error || "Could not load built-in codes."));
      }
    } catch {
      setBuiltinErr("Could not reach the access server.");
    } finally {
      setBuiltinBusy(false);
    }
  }

  async function copyAllBuiltin() {
    try {
      await navigator.clipboard.writeText(builtinCodes.join("\n"));
      setCopied("builtin");
      setTimeout(() => setCopied(""), 1500);
    } catch {}
  }

  const locked = !confirmed || !accessRecord;

  return (
    <div className="min-h-screen flex flex-col text-zinc-100">
      {/* wallpaper / aurora background layer */}
      <div aria-hidden className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
        {wall ? (
          <>
            <div
              className={`absolute inset-0 bg-cover ${wall.pos === "top" ? "bg-top" : "bg-center"}`}
              style={{
                backgroundImage: `url("${wall.src}")`,
                filter: wall.blur ? `blur(${wall.blur}px)` : undefined,
                transform: wall.blur ? "scale(1.08)" : undefined,
              }}
            />
            <div className="absolute inset-0 bg-black" style={{ opacity: (wall.dim ?? 45) / 100 }} />
          </>
        ) : (
          <div className="exodia-aurora" />
        )}
      </div>

      {/* header */}
      <header className="sticky top-0 z-40 border-b border-yellow-500/15 bg-[#050403]/70 backdrop-blur-xl">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-3">
          <span className="h-2.5 w-2.5 rounded-full bg-yellow-400 shadow-[0_0_10px_#c9a227]" />
          <h1 className="text-base font-extrabold tracking-tight">
            <span className="exodia-gold-text">Exodia</span> <span className="text-zinc-500 font-medium">by BRNT™</span>
          </h1>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <WallpaperButton value={wall} onChange={setWall} />
            <a
              href="/brnt-cookie-bridge.zip"
              download
              title="Download the BRNT Cookie Bridge extension (zip) - one-click cookie import on the current page"
              className="inline-flex items-center gap-1.5 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-2.5 py-1.5 font-medium text-yellow-400 transition-colors hover:bg-yellow-500/20"
            >
              <Puzzle className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Cookie Bridge</span>
              <span className="sm:hidden">Bridge</span>
            </a>
            {isAdmin && (
              <span className="hidden sm:inline rounded border border-yellow-500/50 bg-yellow-500/10 px-2 py-0.5 font-bold text-yellow-400" title="Admin mode — live panel management unlocked">
                <Radio className="mr-1 inline h-3 w-3" />ADMIN
              </span>
            )}
            {accessRecord && (
              <span className="hidden sm:inline rounded border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 font-mono text-yellow-400">
                {accessRecord.code} · {accessRecord.days === 0 ? "∞" : `${accessRecord.days}d`}
              </span>
            )}
            <label className="flex items-center gap-1.5 text-zinc-400 cursor-pointer" title="Authorization confirmation">
              <ShieldCheck className="h-3.5 w-3.5" />
              <Switch
                checked={confirmed}
                onCheckedChange={(v) => {
                  setConfirmed(v);
                  try {
                    localStorage.setItem(CONFIRMED_KEY, v ? "1" : "0");
                  } catch {}
                }}
                className="data-[state=checked]:bg-yellow-500"
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="text-zinc-400 hover:text-yellow-400"
              onClick={() => setGateOpen(true)}
              aria-label="Manage member access key"
            >
              <KeyRound className="h-3.5 w-3.5" />
            </Button>
            {accessRecord && (
              <Button
                variant="ghost"
                size="sm"
                className="text-zinc-500 hover:text-rose-400"
                onClick={lockMember}
                title="Forget this member key on this device"
                aria-label="Forget member key"
              >
                <LogOut className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
          <div className="space-y-6 min-w-0">
        {/* access gate */}
        {gateOpen && (
          <section className="exodia-glass rounded-xl p-5 space-y-4" aria-label="Member access">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-yellow-400" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-300">Member access</h2>
              {validating && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-zinc-200">Authorization confirmation</p>
                <p className="text-[11px] text-zinc-500">
                  I confirm I own this system or have written permission to test it.
                </p>
              </div>
              <Switch
                checked={confirmed}
                onCheckedChange={(v) => {
                  setConfirmed(v);
                  try {
                    localStorage.setItem(CONFIRMED_KEY, v ? "1" : "0");
                  } catch {}
                }}
                className="data-[state=checked]:bg-yellow-500"
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="access-code" className="text-xs text-zinc-400">
                  Member access key
                </Label>
                <Input
                  id="access-code"
                  value={accessKey}
                  onChange={(e) => setAccessKey(e.target.value)}
                  placeholder="BRNT-XXXX-XXXX"
                  className="bg-zinc-950 border-zinc-800 font-mono"
                  autoComplete="off"
                />
              </div>
              <Button
                className="self-end bg-yellow-500 hover:bg-yellow-600 text-yellow-950 font-bold"
                onClick={async () => {
                  const ok = await validate(accessKey);
                  if (ok) {
                    try {
                      localStorage.setItem(ACCESS_KEY, accessKey.trim());
                    } catch {}
                  }
                }}
                disabled={validating}
              >
                {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Unlock
              </Button>
            </div>

            <div>
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-yellow-400"
                onClick={() => setShowAdmin((v) => !v)}
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdmin ? "rotate-180" : ""}`} />
                Generate member key (admin)
              </button>
              {showAdmin && (
                <div className="mt-3 space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <Input
                      value={mintAdminInput}
                      onChange={(e) => setMintAdminInput(e.target.value)}
                      placeholder="Admin key"
                      className="bg-zinc-950 border-zinc-800"
                      autoComplete="off"
                    />
                    <select
                      value={adminDays}
                      onChange={(e) => setAdminDays(Number(e.target.value))}
                      className="rounded-md bg-zinc-950 border border-zinc-800 px-2 text-sm"
                      aria-label="Validity days"
                    >
                      <option value={1}>1 day</option>
                      <option value={3}>3 days</option>
                      <option value={7}>7 days</option>
                    </select>
                    <Button onClick={mint} disabled={mintBusy} variant="outline" className="border-zinc-700">
                      {mintBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Generate
                    </Button>
                  </div>
                  {minted && (
                    <div className="flex flex-wrap items-center gap-2 rounded border border-yellow-500/40 bg-yellow-500/10 p-2">
                      <span className="font-mono text-yellow-300 font-bold">{minted.code}</span>
                      <span className="text-[11px] text-zinc-400">
                        valid {minted.days} day(s) · until {new Date(minted.expiresAt).toLocaleString()}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-yellow-400"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(minted.code);
                            setCopied("key");
                            setTimeout(() => setCopied(""), 1500);
                          } catch {}
                        }}
                      >
                        <Copy className="h-3 w-3" /> {copied === "key" ? "Copied" : "Copy"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-yellow-400"
                        onClick={async () => {
                          setAccessKey(minted.code);
                          const ok = await validate(minted.code);
                          if (ok) {
                            try {
                              localStorage.setItem(ACCESS_KEY, minted.code);
                            } catch {}
                          }
                        }}
                      >
                        Use this key
                      </Button>
                    </div>
                  )}
                  {/* built-in accounts: 50 permanent codes, admin-gated */}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      onClick={loadBuiltin}
                      disabled={builtinBusy}
                      variant="outline"
                      className="border-zinc-700"
                      title="List the 50 permanent built-in member accounts"
                    >
                      {builtinBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Show built-in codes (50)
                    </Button>
                    {builtinCodes.length > 0 && (
                      <Button size="sm" variant="ghost" className="text-yellow-400" onClick={copyAllBuiltin}>
                        <Copy className="h-3 w-3" /> {copied === "builtin" ? "Copied all 50" : "Copy all"}
                      </Button>
                    )}
                  </div>
                  {builtinErr && <p className="text-[11px] text-rose-400">{builtinErr}</p>}
                  {builtinOpen && builtinCodes.length > 0 && (
                    <div className="rounded border border-zinc-800 bg-zinc-950 p-2 max-h-64 overflow-y-auto">
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {builtinCodes.map((c, i) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setAccessKey(c)}
                            className="flex items-center justify-between gap-2 rounded px-2 py-1 text-left font-mono text-xs text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-yellow-300"
                            title="Click to fill the member key box"
                          >
                            <span className="text-zinc-600">{String(i + 1).padStart(2, "0")}</span>
                            <span>{c}</span>
                          </button>
                        ))}
                      </div>
                      <p className="mt-1 text-[10px] text-zinc-600">
                        Permanent accounts — never expire, no storage needed. Click one to fill the key box.
                      </p>
                    </div>
                  )}
                  <p className="text-[11px] text-zinc-600">Ask the console owner for the admin key — it is never shown in the app.</p>
                </div>
              )}
            </div>

            {gateError && <p className="text-sm text-rose-400">{gateError}</p>}
          </section>
        )}

        {/* check forms */}
        <Tabs value={mode} onValueChange={setMode}>
          <TabsList className="bg-zinc-900 border border-zinc-800">
            <TabsTrigger value="single" className="data-[state=active]:text-yellow-400">Single check</TabsTrigger>
            <TabsTrigger value="bulk" className="data-[state=active]:text-yellow-400">Bulk check</TabsTrigger>
          </TabsList>
          <TabsContent value="single" className="mt-4">
            <div className="exodia-glass rounded-xl p-4 sm:p-6">
              <SingleCheckForm
                lockedUrl={urlLocked && loginUrl.trim() ? loginUrl : null}
                cookies={sharedCookies}
                onCookiesChange={setSharedCookies}
                onResult={onResult}
                accessKey={accessKey}
              />
            </div>
          </TabsContent>
          <TabsContent value="bulk" className="mt-4">
            <div className="exodia-glass rounded-xl p-4 sm:p-6">
              <BulkCheckForm
                loginUrl={loginUrl}
                onLoginUrlChange={setLoginUrl}
                urlLocked={urlLocked}
                onUrlLockedChange={setUrlLocked}
                sharedCookies={sharedCookies}
                onSharedCookiesChange={setSharedCookies}
                onResult={onResult}
                accessKey={accessKey}
              />
            </div>
          </TabsContent>
        </Tabs>

        {/* results */}
        <ResultsPanel
          results={results}
          running={running}
          onClear={() => setResults([])}
          onRemove={(id) => setResults((prev) => prev.filter((r) => r.id !== id))}
          accessKey={accessKey}
          isAdmin={isAdmin}
          onPushLive={pushLive}
        />

        {locked && (
          <p className="text-center text-xs text-zinc-600">
            Checks are locked until authorization is confirmed and a valid member key is set (the server also enforces it).
          </p>
        )}
          </div>

          {/* right-side live panel */}
          <LivePanel
            accessKey={accessKey}
            isAdmin={isAdmin}
            adminKey={adminKey}
            refreshTick={liveTick}
            onAdminUnlock={(k) => verifyAdmin(k)}
            onAdminLock={lockAdmin}
            onChanged={() => setLiveTick((t) => t + 1)}
          />
        </div>
      </main>

      <footer className="relative z-10 mt-auto border-t border-yellow-500/15">
        <div className="mx-auto max-w-7xl px-4 py-3 text-center text-[11px] text-zinc-600">
          Exodia by BRNT™ · use only on systems you own or are authorized to test
        </div>
      </footer>
    </div>
  );
}
