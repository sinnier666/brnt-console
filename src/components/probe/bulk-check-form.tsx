"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, FolderOpen, FileText, Play, Square } from "lucide-react";
import type { ProbeResult } from "@/lib/probe-types";
import { parseBulkText } from "./parse-bulk";

interface Props {
  loginUrl: string;
  onLoginUrlChange: (v: string) => void;
  urlLocked: boolean;
  onUrlLockedChange: (v: boolean) => void;
  sharedCookies: string;
  onSharedCookiesChange: (v: string) => void;
  onResult: (r: ProbeResult) => void;
  accessKey: string;
}

interface FileEntry {
  name: string;
  content: string;
}

export function BulkCheckForm({
  loginUrl,
  onLoginUrlChange,
  urlLocked,
  onUrlLockedChange,
  sharedCookies,
  onSharedCookiesChange,
  onResult,
  accessKey,
}: Props) {
  const [rowsText, setRowsText] = useState("");
  const [useShared, setUseShared] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [fileErr, setFileErr] = useState("");
  const stopRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  async function readFiles(fileList: FileList | null): Promise<FileEntry[]> {
    if (!fileList) return [];
    const entries: FileEntry[] = [];
    for (const f of Array.from(fileList)) {
      if (!/\.(txt|csv|json|jsonl)$/i.test(f.name)) continue;
      try {
        const text = await f.text();
        entries.push({ name: f.name, content: text });
      } catch {
        /* skip unreadable */
      }
    }
    // dedupe by name
    const seen = new Set<string>();
    return entries.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
  }

  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    setFileErr("");
    const got = await readFiles(e.target.files);
    if (!got.length) {
      setFileErr("No .txt/.csv/.json files found in the selection.");
      return;
    }
    setFiles(got);
  }

  function transferFiles(list: FileList | null) {
    // webkitdirectory input cannot be assigned programmatically; read directly
    void onPickFiles({ target: { files: list } } as unknown as React.ChangeEvent<HTMLInputElement>);
  }

  async function checkRow(row: { url: string | null; username: string; password: string; cookieOnly: boolean; cookieSource?: string }): Promise<ProbeResult | null> {
    const url = row.url || loginUrl;
    if (!url) return null;
    const isCookieOnly = row.cookieOnly || (!row.username && !row.password);
    const cookieText = row.cookieSource ?? (isCookieOnly && useShared ? sharedCookies : "");
    try {
      const res = await fetch("/api/check-login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brnt-access": accessKey },
        body: JSON.stringify({
          url,
          username: row.username,
          password: row.password,
          cookies: cookieText.trim() ? cookieText : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok && !data.verdict) return null;
      return isCookieOnly && cookieText.trim()
        ? { ...data, cookieSource: cookieText.trim() }
        : (data as ProbeResult);
    } catch {
      return null;
    }
  }

  async function run() {
    setFileErr("");
    const hasShared = Boolean(sharedCookies.trim()) && useShared;
    const parsedRows = parseBulkText(rowsText, hasShared);

    if (!loginUrl.trim() && (parsedRows.some((x) => !x.url) || files.length)) {
      setFileErr("Enter the shared Login page URL — rows without their own URL and cookie files need it.");
      return;
    }

    const jobs: Array<() => Promise<void>> = [];

    // rows from textarea
    for (const row of parsedRows) {
      jobs.push(async () => {
        const url = row.url || loginUrl;
        if (!url || row.error) return;
        const r = await checkRow(row);
        if (r) onResult(r);
      });
    }

    // cookie files (each file = one row)
    for (const entry of files) {
      jobs.push(async () => {
        if (!loginUrl) return;
        const r = await checkRow({
          url: null,
          username: "",
          password: "",
          cookieOnly: true,
          cookieSource: entry.content,
        });
        if (r) onResult({ ...r, username: entry.name.replace(/\.(txt|csv|json|jsonl)$/i, "").slice(0, 80) });
      });
    }

    if (!jobs.length) {
      setFileErr("Nothing to check — paste rows or load cookie files.");
      return;
    }

    stopRef.current = false;
    setRunning(true);
    setProgress({ done: 0, total: jobs.length });

    // light concurrency: 2 at a time
    let index = 0;
    const worker = async () => {
      while (!stopRef.current && index < jobs.length) {
        const job = jobs[index++];
        await job();
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    };
    await Promise.all([worker(), worker()]);
    setRunning(false);
  }

  const parsedPreview = parseBulkText(rowsText, Boolean(sharedCookies.trim()) && useShared);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="bulk-url" className="text-xs uppercase tracking-wider text-zinc-400">
            Login page URL (shared)
          </Label>
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
            <Checkbox checked={urlLocked} onCheckedChange={(v) => onUrlLockedChange(Boolean(v))} className="border-zinc-600" />
            Lock URL
          </label>
        </div>
        <input
          id="bulk-url"
          data-testid="bulk-url"
          value={loginUrl}
          onChange={(e) => onLoginUrlChange(e.target.value)}
          placeholder="https://example.com/login"
          disabled={urlLocked}
          className="w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 font-mono text-sm disabled:opacity-60"
          autoComplete="off"
        />
        <p className="text-[11px] text-zinc-500">
          Rows with <code className="text-zinc-400">user : pass</code> or cookie files use this URL. Lock it to protect it from edits.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bulk-rows" className="text-xs uppercase tracking-wider text-zinc-400">
          Rows — url : user : pass &nbsp;|&nbsp; user : pass &nbsp;|&nbsp; cookie-only URL
        </Label>
        <Textarea
          id="bulk-rows"
          value={rowsText}
          onChange={(e) => setRowsText(e.target.value)}
          rows={7}
          placeholder={"https://site.com/login : alice : secret\nbob : hunter2\nhttps://other.com (cookie-only row)"}
          className="bg-zinc-950 border-zinc-800 font-mono text-xs"
        />
        {parsedPreview.length > 0 && (
          <p className="text-[11px] text-yellow-500/90">
            {parsedPreview.length} row(s) parsed · {parsedPreview.filter((r) => r.cookieOnly).length} cookie-only ·{" "}
            {parsedPreview.filter((r) => r.error).length} with issues
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wider text-zinc-400">Session cookies</Label>
        <Textarea
          value={sharedCookies}
          onChange={(e) => onSharedCookiesChange(e.target.value)}
          rows={4}
          placeholder="Shared cookies for cookie-only rows — Netscape cookies.txt, Cookie-Editor JSON, or header string"
          className="bg-zinc-950 border-zinc-800 font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
            <Checkbox checked={useShared} onCheckedChange={(v) => setUseShared(Boolean(v))} className="border-zinc-600" />
            Use shared cookies
          </label>
          <span className="text-zinc-700">|</span>
          <Button type="button" variant="outline" size="sm" className="border-zinc-800 text-zinc-300"
            onClick={() => fileInputRef.current?.click()}>
            <FileText className="h-3.5 w-3.5" /> Select .txt files
          </Button>
          <Button type="button" variant="outline" size="sm" className="border-zinc-800 text-zinc-300"
            onClick={() => folderInputRef.current?.click()}>
            <FolderOpen className="h-3.5 w-3.5" /> Select folder
          </Button>
          {files.length > 0 && <span className="text-[11px] text-yellow-500">{files.length} cookie file(s) loaded</span>}
          <input ref={fileInputRef} type="file" accept=".txt,.csv,.json,.jsonl" multiple hidden onChange={onPickFiles} />
          <input
            ref={folderInputRef}
            type="file"
            hidden
            onChange={(e) => transferFiles(e.target.files)}
            // @ts-expect-error non-standard directory attributes
            webkitdirectory=""
            directory=""
          />
        </div>
        {fileErr && <p className="text-sm text-rose-400">{fileErr}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={running}
          className="bg-yellow-500 hover:bg-yellow-600 text-yellow-950 font-bold">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {running ? `Checking ${progress.done}/${progress.total}…` : "Run bulk check"}
        </Button>
        {running && (
          <Button variant="outline" className="border-zinc-700 text-zinc-300"
            onClick={() => {
              stopRef.current = true;
            }}>
            <Square className="h-3.5 w-3.5" /> Stop
          </Button>
        )}
        {running && (
          <div className="flex-1 min-w-[120px]">
            <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-yellow-500 transition-all"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
