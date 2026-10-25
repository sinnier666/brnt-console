"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Lock, Unlock, Search } from "lucide-react";
import type { ProbeResult } from "@/lib/probe-types";

interface Props {
  lockedUrl: string | null; // when locked, the URL field is fixed
  cookies: string;
  onCookiesChange: (v: string) => void;
  onResult: (r: ProbeResult) => void;
  accessKey: string;
}

export function SingleCheckForm({ lockedUrl, cookies, onCookiesChange, onResult, accessKey }: Props) {
  const [url, setUrl] = useState(lockedUrl || "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function check() {
    setErr("");
    const target = lockedUrl || url;
    if (!target.trim()) {
      setErr("Enter the login page URL first.");
      return;
    }
    if (!username && !cookies.trim()) {
      setErr("Enter a username + password, or provide session cookies.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/check-login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brnt-access": accessKey },
        body: JSON.stringify({
          url: target,
          username,
          password,
          cookies: cookies.trim() ? cookies : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok && !data.verdict) {
        setErr(data.message || data.error || `Check failed (HTTP ${res.status})`);
        return;
      }
      const hasCookies = Boolean(cookies.trim());
      onResult(hasCookies ? { ...data, cookieSource: cookies.trim() } : data);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="probe-url" className="text-xs uppercase tracking-wider text-zinc-400">
          Login page URL
        </Label>
        <div className="flex gap-2">
          <Input
            id="probe-url"
            value={lockedUrl || url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/login"
            disabled={Boolean(lockedUrl)}
            className="bg-zinc-950 border-zinc-800 font-mono text-sm"
            autoComplete="off"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={lockedUrl ? "URL locked" : "URL unlocked"}
            className="border-zinc-800 text-zinc-400 hover:text-yellow-400"
            onClick={() => {
              if (lockedUrl) return; // unlocking is done from the bulk header
            }}
            title={lockedUrl ? "URL locked from bulk mode" : "Type the site's login page URL"}
          >
            {lockedUrl ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
          </Button>
        </div>
        {lockedUrl && (
          <p className="text-[11px] text-zinc-500">
            URL is locked to the bulk-mode login page. Switch to Bulk mode to change it.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="probe-user" className="text-xs uppercase tracking-wider text-zinc-400">
            Username
          </Label>
          <Input
            id="probe-user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username or email"
            className="bg-zinc-950 border-zinc-800"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="probe-pass" className="text-xs uppercase tracking-wider text-zinc-400">
            Password
          </Label>
          <Input
            id="probe-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
            className="bg-zinc-950 border-zinc-800"
            autoComplete="off"
          />
        </div>
      </div>

      <div>
        <button
          type="button"
          className="text-xs text-zinc-400 hover:text-yellow-400 underline underline-offset-4"
          onClick={() => setAdvanced((v) => !v)}
        >
          {advanced ? "Hide" : "Advanced options"} (session cookies)
        </button>
        {advanced && (
          <div className="mt-2 space-y-1.5">
            <Textarea
              value={cookies}
              onChange={(e) => onCookiesChange(e.target.value)}
              rows={5}
              placeholder="Paste session cookies — Netscape cookies.txt, Cookie-Editor JSON, or name=value; name2=value2"
              className="bg-zinc-950 border-zinc-800 font-mono text-xs"
            />
            <p className="text-[11px] text-zinc-500">
              Cookie-only check runs when username/password are empty. Formats: cookies.txt, JSON, header string.
            </p>
          </div>
        )}
      </div>

      {err && <p className="text-sm text-rose-400">{err}</p>}

      <Button
        onClick={check}
        disabled={busy}
        className="w-full sm:w-auto bg-yellow-500 hover:bg-yellow-600 text-yellow-950 font-bold"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        {busy ? "Checking…" : "Check login"}
      </Button>
    </div>
  );
}
