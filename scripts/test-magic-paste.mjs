// Tests for v1.4.0 popup magic-link paste + DevTools "Cookie:" line support.
// Reproduces the user failure from 2026-10-23 (second report): the console's
// magic link was pasted into the popup cookie box -> "No cookies recognised".
// Run: bun /home/z/my-project/scripts/test-magic-paste.mjs

import {
  parseCookieText,
  extractMagicToken,
  decodeMagicToken,
  decodeMagicTokenSmart,
  buildSetAttempts,
} from '../download/brnt-cookie-bridge/shared.js';
import { deflateRawSync } from 'node:zlib';

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

// ---------- build a real BR1 token (same codec as the console) ----------
function b64url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const PAYLOAD = {
  v: 1,
  u: 'https://www.netflix.com/browse',
  c: [
    { n: 'NetflixId', v: '2Ahad6abc', d: '.netflix.com', s: 1, h: 1, ss: 'no_restriction' },
    { n: 'SecureNetflixId', v: 'v%3D3D%26mac%3Dxyz', d: '.netflix.com', s: 1, h: 1, ss: 'no_restriction' },
    { n: 'nfvdca', v: 'auth-xyz', d: '.netflix.com', ss: 'lax' },
  ],
};
const BR1 = 'BR1.' + b64url(deflateRawSync(Buffer.from(JSON.stringify(PAYLOAD), 'utf8')));
const BR0 = 'BR0.' + b64url(Buffer.from(JSON.stringify(PAYLOAD), 'utf8'));

// ---------- [1] extractMagicToken ----------
console.log('[1] extractMagicToken');
const fullLink = `https://www.netflix.com/browse?nftoken=${BR1}`;
eq(extractMagicToken(fullLink), BR1, 'full URL -> token');

// line-wrapped paste, exactly like the user's screenshot
const wrapped = `https://www.netflix.com/browse?\nnftoken=BR1.hVYZj6MGGPwVSLYSztDb3dwj-\nYEbbPCJzyhCDY0xNpc5DPZq_3vKzE6yycu6WJvd1VXf-\n226Ue_wIkcpa`;
eq(extractMagicToken(wrapped), 'BR1.hVYZj6MGGPwVSLYSztDb3dwj-YEbbPCJzyhCDY0xNpc5DPZq_3vKzE6yycu6WJvd1VXf-226Ue_wIkcpa', 'wrapped paste -> token reassembled');

eq(extractMagicToken('https://www.netflix.com/browse?nftoken=BR1.%2Binvalid'), null, 'non-token value -> null');
eq(extractMagicToken('NetflixId=abc; SecureNetflixId=def'), null, 'plain cookie string -> null');
eq(extractMagicToken(''), null, 'empty -> null');
// trailing word glued to the token (whitespace stripped before matching)
const greedy = extractMagicToken(`see https://x.com/?brntoken=${BR0} end`);
eq(/^BR0\./.test(greedy || ''), true, 'brntoken alias found (greedy, may carry trailing junk)');
const pAlias = await decodeMagicTokenSmart(greedy);
eq(pAlias && pAlias.c.length, 3, 'smart decode recovers payload despite glued "end"');

// ---------- [2] decode roundtrip ----------
console.log('[2] decodeMagicToken roundtrip');
const d1 = await decodeMagicToken(BR1);
eq(d1 && d1.c.length, 3, 'BR1 decodes to 3 cookies');
eq(d1 && d1.u, 'https://www.netflix.com/browse', 'BR1 payload URL');
eq(d1 && d1.c[1].name, 'SecureNetflixId', 'cookie name');
eq(d1 && d1.c[1].httpOnly, true, 'httpOnly preserved');
const d2 = await decodeMagicToken(BR0);
eq(d2 && d2.c.length, 3, 'BR0 decodes too');

// decoded cookies feed the standard set-attempt builder
const atts = buildSetAttempts(d1.c[0], 'https://www.netflix.com/');
eq(atts[0].domain, '.netflix.com', 'decoded cookie keeps domain');
eq(atts[0].httpOnly, true, 'decoded cookie keeps httpOnly');
eq(atts[0].url.startsWith('https://netflix.com/'), true, 'attempt targets the site');

// invalid tokens
eq(await decodeMagicToken('BR1.nota-base64!!'), null, 'garbage token -> null');
eq(await decodeMagicToken('BR9.AAAA'), null, 'unknown version -> null');

// ---------- [3] DevTools "Cookie:" line support ----------
console.log('[3] Cookie: header lines');
const devtools = [
  ':method: GET',
  ':scheme: https',
  ':authority: www.netflix.com',
  'cookie: NetflixId=2Ahad6abc; SecureNetflixId=v%3D3D%26mac%3Dxyz; nfvdca=auth-xyz',
  'user-agent: Mozilla/5.0',
].join('\n');
const h1 = parseCookieText(devtools);
eq(h1.format, 'header lines (Cookie: ...)', 'format detected');
eq(h1.cookies.length, 3, '3 cookies from the Cookie: line');
eq(h1.cookies[0].name, 'NetflixId', 'name ok');
eq(h1.cookies[2].value, 'auth-xyz', 'value ok');

const setc = 'Set-Cookie: SecureNetflixId=v%3D3D%26mac%3Dxyz; Path=/; Domain=.netflix.com; HttpOnly; Secure';
const h2 = parseCookieText(setc);
eq(h2.cookies.length, 1, 'Set-Cookie -> single cookie (attributes dropped)');
eq(h2.cookies[0].name, 'SecureNetflixId', 'Set-Cookie name');
eq(h2.cookies[0].value, 'v%3D3D%26mac%3Dxyz', 'Set-Cookie value');

// mixed case + cookie2 + folded continuation
const h3 = parseCookieText('COOKIE2: a=1\nCookie: b=2');
eq(h3.cookies.length, 2, 'COOKIE2: and mixed-case handled');
const h4 = parseCookieText('cookie: NetflixId=abc;\n  SecureNetflixId=def; nfvdca=x');
eq(h4.cookies.length, 3, 'folded (obs-fold) continuation lines joined');

// ---------- [4] regression: old formats untouched ----------
console.log('[4] regression');
const plain = parseCookieText('NetflixId=abc; SecureNetflixId=def');
eq(plain.format, 'header (name=value; ...)', 'plain header format label unchanged');
eq(plain.cookies.length, 2, 'plain header still parses');
eq(parseCookieText('[\n  {"domain": ".netflix.com", "httpOnly": false, "name": "x", "value": "y"}\n]').format, 'JSON', 'JSON still parses');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
