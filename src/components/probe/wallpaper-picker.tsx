"use client";

import { useEffect, useRef, useState } from "react";
import { ImageIcon, Upload, Trash2, Link2 } from "lucide-react";

// Exodia wallpaper feature.
// The user picks any image (file upload or URL); it renders as a fixed
// background behind the whole console with adjustable dim + blur.
// File uploads are downscaled to max 1920px and re-encoded as JPEG so the
// dataURL reliably fits in localStorage (~<1MB typical).

export interface Wallpaper {
  src: string;
  /** 0..85 — black overlay opacity in percent */
  dim: number;
  /** 0..24 — background blur in px */
  blur: number;
}

const KEY = "exodia-wallpaper-v1";

/** Built-in preset: the Exodia keyart shipped with the console at
 * /wallpapers/exodia.jpg. Shown by DEFAULT in every browser until the user
 * explicitly removes it (which stores "null" → gold aurora). */
export const DEFAULT_WALLPAPER: Wallpaper = {
  src: "/wallpapers/exodia.jpg",
  dim: 50,
  blur: 0,
};

export function useWallpaper(): [Wallpaper | null, (w: Wallpaper | null) => void] {
  const [wall, setWall] = useState<Wallpaper | null>(DEFAULT_WALLPAPER);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw === "null") setWall(null); // explicitly removed → gold aurora
      else if (raw) {
        const j = JSON.parse(raw);
        if (j && typeof j.src === "string") setWall(j);
        else setWall(DEFAULT_WALLPAPER);
      }
      // no stored value at all → keep the default Exodia art
    } catch {
      /* keep default */
    }
  }, []);
  const update = (w: Wallpaper | null) => {
    setWall(w);
    try {
      // null is stored as the literal string "null" so "explicitly removed"
      // survives reloads; absent key means "never touched" → default art.
      localStorage.setItem(KEY, w === null ? "null" : JSON.stringify(w));
    } catch {
      /* quota exceeded — keep showing it for this session at least */
    }
  };
  return [wall, update];
}

async function fileToDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
  try {
    const img = document.createElement("img");
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("bad image"));
      img.src = raw;
    });
    const max = 1920;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return raw;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.86);
  } catch {
    return raw; // fall back to the original dataURL if canvas fails
  }
}

export function WallpaperButton({
  value,
  onChange,
}: {
  value: Wallpaper | null;
  onChange: (w: Wallpaper | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(f: File | undefined | null) {
    if (!f) return;
    setErr("");
    try {
      const src = await fileToDataUrl(f);
      onChange({ src, dim: value?.dim ?? 45, blur: value?.blur ?? 0 });
      setErr("");
    } catch {
      setErr("Could not read that image.");
    }
  }

  function applyUrl() {
    const u = url.trim();
    if (!u) return;
    if (!/^(https?:)?\/\//i.test(u) && !u.startsWith("data:")) {
      setErr("Enter a full image URL (https://...)");
      return;
    }
    setErr("");
    onChange({ src: u, dim: value?.dim ?? 45, blur: value?.blur ?? 0 });
    setUrl("");
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Set a custom wallpaper"
        aria-label="Wallpaper settings"
        className="inline-flex items-center gap-1.5 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-2.5 py-1.5 font-medium text-yellow-400 transition-colors hover:bg-yellow-500/20"
      >
        <ImageIcon className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Wallpaper</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="exodia-glass absolute right-0 top-full z-50 mt-2 w-72 rounded-xl p-3 space-y-3 text-xs">
            {value?.src ? (
              <div
                className="h-16 rounded-lg border border-yellow-500/20 bg-cover bg-center"
                style={{ backgroundImage: `url("${value.src}")` }}
              />
            ) : (
              <div className="h-16 rounded-lg border border-yellow-500/20 bg-black/40 grid place-items-center text-[11px] text-zinc-500">
                No wallpaper — gold aurora active
              </div>
            )}

            <div className="space-y-1">
              <p className="text-[11px] font-semibold text-zinc-400">Built-in</p>
              <button
                type="button"
                onClick={() => {
                  onChange({ ...DEFAULT_WALLPAPER });
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg border border-yellow-500/30 bg-black/40 p-1.5 text-left transition-colors hover:border-yellow-500/60"
              >
                <span
                  className="h-9 w-14 shrink-0 rounded border border-yellow-500/30 bg-cover bg-center"
                  style={{ backgroundImage: `url("${DEFAULT_WALLPAPER.src}")` }}
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-yellow-300">Exodia the Forbidden One</span>
                  <span className="block text-[10px] text-zinc-500">official console keyart — dark &amp; gold</span>
                </span>
              </button>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-yellow-500/40 bg-yellow-500/15 px-2 py-1.5 font-semibold text-yellow-300 hover:bg-yellow-500/25 transition-colors"
            >
              <Upload className="h-3.5 w-3.5" /> Upload image from this device
            </button>

            <div className="flex gap-1.5">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyUrl();
                }}
                placeholder="…or paste image URL"
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-black/50 px-2 py-1.5 outline-none focus:border-yellow-500/60"
              />
              <button
                type="button"
                onClick={applyUrl}
                className="rounded-md border border-zinc-700 px-2 text-zinc-300 hover:border-yellow-500/50 hover:text-yellow-300"
                aria-label="Apply wallpaper URL"
              >
                <Link2 className="h-3.5 w-3.5" />
              </button>
            </div>

            <label className="block space-y-1">
              <span className="flex justify-between text-[11px] text-zinc-400">
                <span>Darkness</span>
                <span>{value?.dim ?? 45}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={85}
                value={value?.dim ?? 45}
                onChange={(e) =>
                  value && onChange({ ...value, dim: Number(e.target.value) })
                }
                className="w-full"
              />
            </label>

            <label className="block space-y-1">
              <span className="flex justify-between text-[11px] text-zinc-400">
                <span>Blur</span>
                <span>{value?.blur ?? 0}px</span>
              </span>
              <input
                type="range"
                min={0}
                max={24}
                value={value?.blur ?? 0}
                onChange={(e) =>
                  value && onChange({ ...value, blur: Number(e.target.value) })
                }
                className="w-full"
              />
            </label>

            {err && <p className="text-[11px] text-rose-400">{err}</p>}

            {value && (
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-rose-500/40 px-2 py-1.5 font-semibold text-rose-400 hover:bg-rose-500/10 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove wallpaper
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
