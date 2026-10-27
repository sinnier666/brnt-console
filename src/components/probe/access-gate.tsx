"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { setAccess, formatRemaining, type AccessInfo } from "@/lib/access-client";
import type { AccessRecord } from "@/lib/access-store";
import {
  ShieldCheck,
  KeyRound,
  Loader2,
  Copy,
  Check,
  ChevronDown,
  Lock,
  BadgeCheck,
  Clock,
  Wrench,
  Eye,
  EyeOff,
} from "lucide-react";

interface VerifyResponse {
  ok?: boolean;
  admin?: boolean;
  days?: number | null;
  expiresAt?: string | null;
  message?: string;
  error?: string;
}

interface GenerateResponse {
  ok?: boolean;
  record?: AccessRecord;
  error?: string;
}

export function AccessGate({
  mode,
  access,
  onClose,
}: {
  /** "lock" = console is locked (no close button); "manage" = opened from the header chip. */
  mode: "lock" | "manage";
  access: AccessInfo | null;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState("");

  const [adminKey, setAdminKey] = useState("");
  const [days, setDays] = useState("3");
  const [note, setNote] = useState("");
  const [generating, setGenerating] = useState(false);
  const [minted, setMinted] = useState<AccessRecord | null>(null);
  const [adminError, setAdminError] = useState("");
  const [adminOpen, setAdminOpen] = useState(mode === "lock");
  const [copied, setCopied] = useState(false);
  const [keys, setKeys] = useState<AccessRecord[] | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);

  const verify = async () => {
    if (!code.trim() || verifying) return;
    setVerifying(true);
    setVerifyError("");
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "verify", code: code.trim() }),
      });
      const data = (await res.json()) as VerifyResponse;
      if (!res.ok || !data.ok) {
        setVerifyError(data.error ?? "Could not verify this key.");
        return;
      }
      setAccess({
        code: code.trim().toUpperCase(),
        role: data.admin ? "admin" : "member",
        days: (data.days as AccessInfo["days"]) ?? null,
        expiresAt: data.expiresAt ? Date.parse(data.expiresAt) : null,
      });
    } catch {
      setVerifyError("Network error — try again.");
    } finally {
      setVerifying(false);
    }
  };

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    setAdminError("");
    setMinted(null);
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "generate",
          adminKey: adminKey.trim(),
          days: Number(days),
          note: note.trim(),
        }),
      });
      const data = (await res.json()) as GenerateResponse;
      if (!res.ok || !data.ok || !data.record) {
        setAdminError(data.error ?? "Could not generate a key.");
        return;
      }
      setMinted(data.record);
      loadKeys();
    } catch {
      setAdminError("Network error — try again.");
    } finally {
      setGenerating(false);
    }
  };

  const loadKeys = async () => {
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list", adminKey: adminKey.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; records?: AccessRecord[]; error?: string };
      if (res.ok && data.ok && data.records) setKeys(data.records);
    } catch {
      /* list is optional */
    }
  };

  const copyMinted = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="BRNT member access"
    >
      <Card className="w-full max-w-md bg-card/70 shadow-2xl shadow-black/50 backdrop-blur-2xl">
        <CardHeader className="items-center text-center">
          <div className="mx-auto mb-1 flex h-14 w-14 items-center justify-center rounded-2xl bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-inset ring-white/10">
            <Lock className="h-7 w-7" />
          </div>
          <CardTitle className="flex items-center justify-center gap-2 text-xl font-bold tracking-tight">
            BRNT<span className="text-fuchsia-400">™</span> Member Access
          </CardTitle>
          <CardDescription>
            {mode === "lock"
              ? "This console is locked. Enter the access key you were given to continue."
              : "Your access is active. Manage keys below or continue to the console."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {mode === "manage" && access && (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
              <BadgeCheck className="h-5 w-5 shrink-0 text-emerald-400" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium text-emerald-200">Access active</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {access.code} · <Clock className="inline h-3 w-3" />{" "}
                  {formatRemaining(access.expiresAt)}
                </p>
              </div>
              <Button size="sm" onClick={onClose}>
                Continue
              </Button>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ag-code">Access key</Label>
            <div className="flex gap-2">
              <Input
                id="ag-code"
                placeholder="BRNT-XXXX-XXXX"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && verify()}
                className="font-mono uppercase"
                autoComplete="off"
                spellCheck={false}
              />
              <Button onClick={verify} disabled={!code.trim() || verifying}>
                {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Unlock
              </Button>
            </div>
            {verifyError && <p className="text-xs text-red-400">{verifyError}</p>}
          </div>

          <Collapsible open={adminOpen} onOpenChange={setAdminOpen}>
            <CollapsibleTrigger className="group flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <Wrench className="h-4 w-4" />
              Owner: generate member keys (1 / 3 / 7 days)
              <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <div className="space-y-1.5">
                <Label htmlFor="ag-admin">Admin key</Label>
                <div className="relative">
                  <Input
                    id="ag-admin"
                    type={showAdmin ? "text" : "password"}
                    placeholder="Admin master key"
                    value={adminKey}
                    onChange={(e) => setAdminKey(e.target.value)}
                    className="pr-10 font-mono"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowAdmin((v) => !v)}
                    aria-label={showAdmin ? "Hide admin key" : "Show admin key"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showAdmin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Default admin key is <span className="font-mono">brnt-admin</span> — capitals or
                  lowercase both work. Set the BRNT_ADMIN_KEY environment variable to change it.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ag-days">Access length</Label>
                  <Select value={days} onValueChange={setDays}>
                    <SelectTrigger id="ag-days">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 day</SelectItem>
                      <SelectItem value="3">3 days</SelectItem>
                      <SelectItem value="7">7 days</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ag-note">Note (optional)</Label>
                  <Input
                    id="ag-note"
                    placeholder="e.g. member @alice"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={120}
                  />
                </div>
              </div>
              <Button
                variant="outline"
                onClick={generate}
                disabled={!adminKey.trim() || generating}
                className="w-full"
              >
                {generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                Generate member key
              </Button>
              {adminError && <p className="text-xs text-red-400">{adminError}</p>}

              {minted && (
                <div className="space-y-2 rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/10 p-3">
                  <p className="text-xs font-medium text-fuchsia-200">
                    New {minted.days}-day key — give this to the member:
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1.5 font-mono text-sm text-fuchsia-300">
                      {minted.code}
                    </code>
                    <Button size="sm" variant="outline" onClick={copyMinted}>
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Expires {new Date(minted.expiresAt).toLocaleString()}
                  </p>
                </div>
              )}

              {keys && keys.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Issued keys</p>
                  <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-white/10 p-2">
                    {keys.map((k) => (
                      <div key={k.code} className="flex items-center justify-between gap-2 text-xs">
                        <code className="truncate font-mono">{k.code}</code>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {k.note && <span className="max-w-28 truncate text-muted-foreground">{k.note}</span>}
                          <Badge variant="outline" className="px-1 text-[10px] font-normal">
                            {k.days}d
                          </Badge>
                          <Badge
                            variant="outline"
                            className={`px-1 text-[10px] font-normal ${
                              k.status === "active"
                                ? "border-emerald-500/40 text-emerald-400"
                                : "border-zinc-500/40 text-zinc-500"
                            }`}
                          >
                            {k.status}
                          </Badge>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>

          <p className="flex items-center justify-center gap-1.5 pt-1 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" /> Keys are validated server-side and checked on
            every run.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
