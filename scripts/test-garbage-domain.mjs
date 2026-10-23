// Tests for the v1.3.0 malformed-export repair in the BRNT Cookie Bridge.
// Reproduces the user failure from 2026-10-23: a hand-built JSON whose
// "domain" field contained the whole "SecureNetflixId=..." pair ->
// old build auto-filled a garbage Site URL -> "Applied 0/1 cookies".
// Run: bun /home/z/my-project/scripts/test-garbage-domain.mjs

import {
  parseCookieText,
  deriveSiteUrl,
  normalizeUrl,
  buildSetAttempts,
  looksLikeDomain,
} from '../download/brnt-cookie-bridge/shared.js';

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok - ${label}`);
  } else {
    fail++;
    console.error(`  FAIL - ${label}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

const VAL = 'v%3D3D%26mac%3DAQEAEQABABQuqOB9t5DCyNCqNp4h1qEunumMo7wipVk.%26dt%3D3D1792721303718';

// ---------- [1] looksLikeDomain ----------
console.log('[1] looksLikeDomain');
eq(looksLikeDomain('.netflix.com'), true, 'leading dot ok');
eq(looksLikeDomain('netflix.com'), true, 'plain host ok');
eq(looksLikeDomain('www.primevideo.com'), true, 'multi-label ok');
eq(looksLikeDomain('1.2.3.4'), true, 'IPv4 ok');
eq(looksLikeDomain('localhost'), true, 'localhost ok');
eq(looksLikeDomain('SecureNetflixId=v%3D3D%26mac%3D...'), false, 'name=value pair rejected');
eq(looksLikeDomain('a=b.c'), false, 'embedded = rejected');
eq(looksLikeDomain(''), false, 'empty rejected');
eq(looksLikeDomain('not a domain'), false, 'spaces rejected');
eq(looksLikeDomain('abc'), false, 'no dot rejected');

// ---------- [2] the user's exact mangled JSON (reconstructed from the screenshot) ----------
console.log('[2] user mangled JSON: domain = whole name=value pair');
const mangled = JSON.stringify([
  {
    domain: `SecureNetflixId=${VAL}`,
    expirationDate: 1900000000,
    hostOnly: true,
    httpOnly: false,
    name: 'SecureNetflixId',
    path: '/',
    sameSite: 'lax',
    secure: true,
    session: false,
    storeId: null,
    value: VAL,
  },
]);
const m = parseCookieText(mangled);
eq(m.format, 'JSON', 'still detected as JSON');
eq(m.cookies.length, 1, '1 cookie parsed');
eq(m.cookies[0].name, 'SecureNetflixId', 'name kept');
eq(m.cookies[0].domain, undefined, 'garbage domain dropped (host-only)');
eq(m.cookies[0].value, VAL, 'value intact (not re-wrapped)');
eq(deriveSiteUrl(m.cookies), null, 'site derivation NOT poisoned by garbage domain');

const atts = buildSetAttempts(m.cookies[0], 'https://www.netflix.com/');
eq(atts.every((a) => a.url.startsWith('https://www.netflix.com/')), true, 'every attempt targets the real site host');
eq(atts.some((a) => a.domain), false, 'no attempt carries the garbage domain');
eq(atts[0].name, 'SecureNetflixId', 'attempt name ok');
eq(atts[0].secure, true, 'attempt secure ok');
eq(atts[0].expirationDate, 1900000000, 'attempt expiry ok');

// ---------- [3] variant: value empty, garbage domain holds the only pair ----------
console.log('[3] value empty -> repaired from the pair inside domain');
const mangled2 = JSON.stringify([
  { domain: `SecureNetflixId=${VAL}`, name: 'SecureNetflixId', value: '' },
]);
const m2 = parseCookieText(mangled2);
eq(m2.cookies[0].domain, undefined, 'garbage domain dropped');
eq(m2.cookies[0].value, VAL, 'value salvaged from the pair');

// ---------- [4] variant: value double-wrapped as name=value ----------
console.log('[4] value double-wrapped -> unwrapped');
const mangled3 = JSON.stringify([
  { domain: '.netflix.com', name: 'NetflixId', value: `NetflixId=2Ahad6abc` },
]);
const m3 = parseCookieText(mangled3);
eq(m3.cookies[0].domain, '.netflix.com', 'valid domain kept');
eq(m3.cookies[0].value, '2Ahad6abc', 'double-wrapped value unwrapped');

// ---------- [5] good exports still behave exactly as before ----------
console.log('[5] regression: well-formed Cookie-Editor JSON');
const good = parseCookieText(
  JSON.stringify([
    { name: 'SecureNetflixId', value: VAL, domain: '.netflix.com', path: '/', secure: true, httpOnly: true },
    { name: 'NetflixId', value: '2Ahad6abc', domain: '.netflix.com', path: '/', secure: true, httpOnly: true },
  ])
);
eq(good.cookies.length, 2, '2 cookies');
eq(good.cookies[0].domain, '.netflix.com', 'domain kept');
eq(good.cookies[0].value, VAL, 'value untouched');
eq(deriveSiteUrl(good.cookies), 'https://netflix.com/', 'site derived');
const ga = buildSetAttempts(good.cookies[0], 'https://www.netflix.com/');
eq(ga[0].domain, '.netflix.com', 'domain cookie attempt keeps domain');
eq(ga.some((a) => a.url.startsWith('https://netflix.com/')), true, 'fallback host-only attempt exists');

// ---------- [6] garbage site URL is rejected up-front ----------
console.log('[6] normalizeUrl rejects the old auto-filled garbage');
let threw = false;
try {
  normalizeUrl('https://securenetflixid=v%3d3d%26mac%3daqeaeqababqu');
} catch {
  threw = true;
}
eq(threw, true, 'host with =/%/; rejected');
eq(normalizeUrl('www.netflix.com'), 'https://www.netflix.com/', 'bare host still normalized');

// ---------- [7] header string with one pair still parses (single-cookie flows) ----------
console.log('[7] header string regression');
const h = parseCookieText(`SecureNetflixId=${VAL}`);
eq(h.format, 'header (name=value; ...)', 'format detected');
eq(h.cookies[0].name, 'SecureNetflixId', 'name ok');
eq(h.cookies[0].value, VAL, 'value ok');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
