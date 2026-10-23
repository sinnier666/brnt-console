// Unit tests for the BRNT Cookie Bridge shared.js parser.
// Run: bun /home/z/my-project/scripts/test-cookie-parser.mjs

import {
  parseCookieText,
  deriveSiteUrl,
  normalizeUrl,
  mapSameSite,
  buildSetAttempts,
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

// ---------- 1. Netscape cookies.txt (with #HttpOnly_, dot domains, paths, expiry) ----------
const netscape = [
  '# Netscape HTTP Cookie File',
  '# This is a generated file! Do not edit.',
  '',
  '#HttpOnly_.primevideo.com\tTRUE\t/\tTRUE\t1987654321\tsession-id\t123-4567890',
  '.amazon.com\tTRUE\t/\tFALSE\t0\tubid-main\t130-1111111',
  '#HttpOnly_www.primevideo.com\tFALSE\t/region/eu\tTRUE\t0\tat-main\tExpiredValue',
].join('\n');

console.log('[1] Netscape cookies.txt');
const n = parseCookieText(netscape);
eq(n.format, 'Netscape cookies.txt', 'format detected');
eq(n.cookies.length, 3, '3 cookies parsed');
eq(n.cookies[0].name, 'session-id', 'cookie 1 name');
eq(n.cookies[0].domain, '.primevideo.com', 'cookie 1 domain');
eq(n.cookies[0].httpOnly, true, '#HttpOnly_ prefix honoured');
eq(n.cookies[0].secure, true, 'cookie 1 secure');
eq(n.cookies[0].expirationDate, 1987654321, 'expiry parsed');
eq(n.cookies[1].expirationDate, undefined, 'expires=0 -> session cookie');
eq(n.cookies[2].path, '/region/eu', 'custom path kept');

// ---------- 2. Cookie-Editor JSON array ----------
const ceJson = JSON.stringify([
  { name: 'sid', value: 'abc', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: 1900000000 },
  { name: 'theme', value: 'dark', session: true, domain: 'example.com', path: '/' },
]);
console.log('[2] Cookie-Editor JSON array');
const j = parseCookieText(ceJson);
eq(j.format, 'JSON', 'format detected');
eq(j.cookies.length, 2, '2 cookies parsed');
eq(j.cookies[0].sameSite, 'no_restriction', 'sameSite kept');
eq(j.cookies[1].expirationDate, undefined, 'session:true clears expiry');

// ---------- 3. JSON object map ----------
console.log('[3] JSON object map');
const m = parseCookieText('{"x":"1","y":"2"}');
eq(m.format, 'JSON', 'format detected');
eq(m.cookies.length, 2, '2 cookies');
eq(m.cookies[0], { name: 'x', value: '1' }, 'map entry -> cookie');

// ---------- 4. Header string ----------
console.log('[4] Header string');
const h = parseCookieText('a=1; b=two words; c=three=equals;  ; empty');
eq(h.cookies.length, 3, '3 cookies (empty piece skipped)');
eq(h.cookies[1].value, 'two words', 'space value kept');
eq(h.cookies[2].value, 'three=equals', '= inside value kept');

// ---------- 5. Multi-line header paste ----------
console.log('[5] Multi-line header paste');
const ml = parseCookieText('foo=bar\nbaz=qux');
eq(ml.cookies.length, 2, 'newline separated parsed');

// ---------- 6. Garbage / empty ----------
console.log('[6] Empty & garbage');
eq(parseCookieText('').cookies, [], 'empty -> []');
eq(parseCookieText('hello world this is not cookies').cookies, [], 'garbage -> []');

// ---------- 7. deriveSiteUrl ----------
console.log('[7] deriveSiteUrl');
eq(deriveSiteUrl([]), null, 'empty -> null');
eq(deriveSiteUrl([{ name: 'a', value: 'b', domain: '' }]), null, 'blank domain -> null');
eq(deriveSiteUrl(parseCookieText(netscape).cookies), 'https://www.primevideo.com/', 'longest/most specific domain wins');
eq(deriveSiteUrl([{ name: 'a', value: 'b' }]), null, 'host-only only -> null');

// ---------- 8. normalizeUrl ----------
console.log('[8] normalizeUrl');
eq(normalizeUrl('www.primevideo.com/region/eu'), 'https://www.primevideo.com/region/eu', 'scheme added');
eq(normalizeUrl('http://localhost:3000/x'), 'http://localhost:3000/x', 'http kept');
let threw = false;
try { normalizeUrl(''); } catch { threw = true; }
eq(threw, true, 'empty throws');

// ---------- 9. mapSameSite ----------
console.log('[9] mapSameSite');
eq(mapSameSite('None'), 'no_restriction', 'None -> no_restriction');
eq(mapSameSite('Lax'), 'lax', 'Lax -> lax');
eq(mapSameSite(undefined), null, 'undefined -> null');

// ---------- 10. buildSetAttempts fallback chain ----------
console.log('[10] buildSetAttempts');
const base = 'https://www.primevideo.com/';
const att = buildSetAttempts(
  { name: 'sid', value: 'v', domain: '.primevideo.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: 100 },
  base
);
eq(att.length >= 3, true, 'has multiple attempts');
eq(att[0].domain, '.primevideo.com', 'first attempt keeps domain');
eq(att[0].httpOnly, true, 'first attempt keeps httpOnly');
eq(att[0].sameSite, 'no_restriction', 'first attempt keeps sameSite');
eq(att[att.length - 1].name, 'sid', 'minimal attempt keeps name');
const urls = new Set(att.map((a) => a.url));
eq(urls.size >= 1, true, 'urls present');
eq(att[0].url, 'https://primevideo.com/', 'cookie url host = dot-domain stripped');
eq(att[0].domain, '.primevideo.com', 'domain cookie keeps dot for chrome.cookies.set');

// SameSite=None without secure must not be first-attempt-invalid: check secure forced by https base
const att2 = buildSetAttempts({ name: 'a', value: 'b' }, 'https://example.com/');
eq(att2[0].secure, true, 'https base forces secure');
const att3 = buildSetAttempts({ name: 'a', value: 'b' }, 'http://localhost:3000/');
eq(att3[0].secure, false, 'http base stays insecure');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
