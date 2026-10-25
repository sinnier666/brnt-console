// Netflix-native nftoken minting (Task 29).
//
// Given a Netflix session's NetflixId cookie, calls the iOS FTL API
// (ios.prod.ftl.netflix.com/iosui/user) exactly like the iOS client does and
// extracts the account's NATIVE login token, producing links shaped like:
//
//   https://netflix.com/?nftoken=<native token>
//
// Unlike the BR1./BR0. links built by magic-link.ts (cookies travel inside
// the URL and need the Cookie Bridge extension), these tokens are minted by
// Netflix itself: opening the link in ANY browser — no extension — makes
// Netflix's own servers validate the token, set NetflixId/SecureNetflixId
// and land the visitor logged-in. Netflix rotates the token after use, so
// the link may only work once (a fresh one can be minted again any time
// while the source session stays alive).

import { parseCookieText, type ParsedCookie } from "./cookies";

const API_URL = "https://ios.prod.ftl.netflix.com/iosui/user/15.48";

// Exact iOS client request shape (proven working from datacenter IPs).
const QUERY_PARAMS: Record<string, string> = {
  appVersion: "15.48.1",
  config:
    '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
  device_type: "NFAPPL-02-",
  esn: "NFAPPL-02-IPHONE8%3D1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
  idiom: "phone",
  iosVersion: "15.8.5",
  isTablet: "false",
  languages: "en-US",
  locale: "en-US",
  maxDeviceWidth: "375",
  model: "saget",
  modelType: "IPHONE8-1",
  odpAware: "true",
  path: '["account","token","default"]',
  pathFormat: "graph",
  pixelDensity: "2.0",
  progressive: "false",
  responseFormat: "json",
};

const BASE_HEADERS: Record<string, string> = {
  "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
  "x-netflix.request.attempt": "1",
  "x-netflix.request.client.user.guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
  "x-netflix.context.profile-guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
  "x-netflix.request.routing":
    '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
  "x-netflix.context.app-version": "15.48.1",
  "x-netflix.argo.translated": "true",
  "x-netflix.context.form-factor": "phone",
  "x-netflix.context.sdk-version": "2012.4",
  "x-netflix.client.appversion": "15.48.1",
  "x-netflix.context.max-device-width": "375",
  "x-netflix.context.ab-tests": "",
  "x-netflix.tracing.cl.useractionid": "4DC655F2-9C3C-4343-8229-CA1B003C3053",
  "x-netflix.client.type": "argo",
  "x-netflix.client.ftl.esn":
    "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
  "x-netflix.context.locales": "en-US",
  "x-netflix.context.top-level-uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
  "x-netflix.client.iosversion": "15.8.5",
  "accept-language": "en-US;q=1",
  "x-netflix.argo.abtests": "",
  "x-netflix.context.os-version": "15.8.5",
  "x-netflix.request.client.context": '{"appState":"foreground"}',
  "x-netflix.context.ui-flavor": "argo",
  "x-netflix.argo.nfnsm": "9",
  "x-netflix.context.pixel-density": "2.0",
  "x-netflix.request.toplevel.uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
  "x-netflix.request.client.timezoneid": "Asia/Dhaka",
};

export interface NetflixAuth {
  netflixId: string;
  secureNetflixId?: string;
  nfvdid?: string;
}

export interface NativeToken {
  link: string;
  tokenPreview: string;
  tokenLength: number;
  expires: number | null; // epoch seconds
}

/** Accepts raw cookie text (Netscape / JSON / header string) or parsed cookies. */
export function extractNetflixAuth(source: string | ParsedCookie[]): NetflixAuth | null {
  const cookies: ParsedCookie[] =
    typeof source === "string" ? parseCookieText(source).cookies : source;
  const byName = new Map<string, string>();
  for (const c of cookies) {
    if (c.name && !byName.has(c.name)) byName.set(c.name, c.value == null ? "" : String(c.value));
  }
  const netflixId = byName.get("NetflixId");
  if (!netflixId) return null;
  return {
    netflixId,
    secureNetflixId: byName.get("SecureNetflixId") || undefined,
    nfvdid: byName.get("nfvdid") || undefined,
  };
}

function unquote(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

async function callTokenApi(netflixIdValue: string): Promise<{ token: string; expires: number | null } | null> {
  const qs = new URLSearchParams(QUERY_PARAMS);
  const res = await fetch(`${API_URL}?${qs.toString()}`, {
    headers: { ...BASE_HEADERS, Cookie: `NetflixId=${netflixIdValue}` },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Netflix iOS API returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    value?: { account?: { token?: { default?: { token?: string; expires?: number } } } };
  };
  const tok = data?.value?.account?.token?.default || {};
  const token = tok.token;
  if (!token) return null;
  let expires = Number(tok.expires);
  if (Number.isFinite(expires) && String(Math.round(expires)).length === 13) expires /= 1000; // ms -> s
  return {
    token: String(token),
    expires: Number.isFinite(expires) && expires > 0 ? Math.round(expires) : null,
  };
}

/**
 * Mint a native nftoken for the session. Tries the raw (URL-encoded, as
 * stored) NetflixId first, then the decoded variant — different export tools
 * store either form.
 */
export async function mintNativeNftoken(auth: NetflixAuth): Promise<NativeToken> {
  const attempts = Array.from(new Set([auth.netflixId, unquote(auth.netflixId)]));
  let lastMissing = true;
  for (const value of attempts) {
    const got = await callTokenApi(value);
    if (got) {
      return {
        link: "https://netflix.com/?nftoken=" + got.token,
        tokenPreview: got.token.slice(0, 20) + "…",
        tokenLength: got.token.length,
        expires: got.expires,
      };
    }
    lastMissing = true;
  }
  if (lastMissing) {
    throw new Error(
      "Netflix acknowledged the session but returned no login token — the session may be half-dead or device-locked. Re-export fresh cookies."
    );
  }
  throw new Error("unreachable");
}
