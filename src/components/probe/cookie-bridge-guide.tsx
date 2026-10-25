"use client";

import { Download, Puzzle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * BRNT Cookie Bridge — install & usage guide.
 * Rendered in two places: a dialog opened from the header "Cookie Bridge"
 * button, and a full section at the bottom of the main column.
 */

export function CookieBridgeSteps() {
  return (
    <div className="space-y-5 text-sm">
      {/* download */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
        <a
          href="/brnt-cookie-bridge.zip"
          download
          className="inline-flex items-center gap-1.5 rounded-md bg-yellow-500 px-3 py-1.5 text-xs font-bold text-yellow-950 transition-colors hover:bg-yellow-600"
        >
          <Download className="h-3.5 w-3.5" />
          Download Cookie Bridge
        </a>
        <span className="text-xs text-zinc-400">
          v1.2.1 — saves <code>brnt-cookie-bridge.zip</code>
        </span>
      </div>

      {/* install */}
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
          Install — one time, about 30 seconds
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-zinc-300 marker:font-bold marker:text-yellow-500">
          <li>
            Unzip the download: right-click it → <b>Extract All</b> — you get a{" "}
            <code>brnt-cookie-bridge</code> folder
          </li>
          <li>
            Open a new tab, type <code>chrome://extensions</code> in the address
            bar and press Enter
          </li>
          <li>
            Turn <b>Developer mode</b> ON — the toggle in the top-right corner
          </li>
          <li>
            Click <b>Load unpacked</b> (top-left) and select the unzipped{" "}
            <code>brnt-cookie-bridge</code> folder
          </li>
          <li>
            (Optional) Pin it: click the puzzle-piece icon in the toolbar → pin{" "}
            <b>BRNT Cookie Bridge</b>
          </li>
        </ol>
      </div>

      {/* usage */}
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
          Use it — every session
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-zinc-300 marker:font-bold marker:text-yellow-500">
          <li>
            In the console, click <b>NFT - open live</b> on a live session (or
            open a magic link from a result)
          </li>
          <li>
            The site opens with a special link — the extension applies the
            cookies <b>by itself</b> and reloads the page logged-in. Nothing
            else to click.
          </li>
          <li>
            Manual way: click the extension icon → load a cookie{" "}
            <code>.txt</code> / <code>.json</code> file or paste the cookies →{" "}
            <b>Apply &amp; open site</b>
          </li>
        </ol>
      </div>

      {/* good to know */}
      <ul className="list-disc space-y-1 pl-5 text-[11px] text-zinc-500">
        <li>A magic link contains the live session — treat it like a password and share it only with people you trust.</li>
        <li>Site still logged-out after opening? The session died on the site&apos;s side — re-check it in the console first.</li>
        <li>Works in Chrome, Edge, Brave and other Chromium browsers. Firefox is not supported.</li>
        <li>Already installed an older version? Re-download, replace the folder, then click the reload arrow on <code>chrome://extensions</code> to get the new icon.</li>
      </ul>
    </div>
  );
}

export function CookieBridgeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="exodia-glass max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Puzzle className="h-4 w-4 text-yellow-400" />
            BRNT Cookie Bridge
          </DialogTitle>
          <DialogDescription>
            Applies the session cookies to the real site and opens it
            logged-in — a web page itself is not allowed to do that, the
            extension is.
          </DialogDescription>
        </DialogHeader>
        <CookieBridgeSteps />
      </DialogContent>
    </Dialog>
  );
}
