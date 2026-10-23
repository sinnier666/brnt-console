#!/usr/bin/env node
// Task 30: v1.5.0 regression tests.
// Reproduces the EXACT "Applied 0/1 cookies" input from the user screenshot
// (hand-built JSON with the SecureNetflixId pair inside the "domain" field,
// trailing ";") + native-link paste detection + value sanitization.
import {
  parseCookieText,
  buildSetAttempts,
  sanitizeCookieValue,
  salvagePairsFromGarbage,
  extractMagicToken,
  extractNativeLink,
  deriveSiteUrl,
  normalizeUrl,
} from '../download/brnt-cookie-bridge/shared.js';

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
}

// --- the EXACT mangled input class from the screenshot (v1.4.0 -> 0/1) ---
const SCREENSHOT_JSON = JSON.stringify([
  {
    name: 'SecureNetflixId',
    httpOnly: false,
    domain: 'SecureNetflixId=v%3D3%26mac%3DAQEAEQABABQuqOB9t5DCyMCqNp4hiQunUmMo%2BwipVk.%26dt%3D1797271303718;',
    secure: true,
  },
]);

// variant where the whole pair chain was dropped into domain, no name/value
const CHAIN_JSON = JSON.stringify([
  { httpOnly: false, domain: 'NetflixId=ct%3DBgjAAA; SecureNetflixId=v%3D3%26mac%3DBBB;' },
]);

console.log('--- screenshot input (single pair in domain field, trailing ";") ---');
{
  const r = parseCookieText(SCREENSHOT_JSON);
  ok('parses as JSON', r.format === 'JSON');
  ok('1 cookie salvaged', r.cookies.length === 1, `got ${r.cookies.length}`);
  const c = r.cookies[0];
  ok('name is SecureNetflixId', c.name === 'SecureNetflixId', c.name);
  ok('value has NO trailing ";"', c.value.endsWith('718') && !c.value.includes(';'), JSON.stringify(c.value.slice(-12)));
  ok('value still percent-decoded-safe', c.value.startsWith('v%3D3%26mac%3D'));
  ok('garbage domain dropped', !c.domain);
  ok('site auto-fill not poisoned', deriveSiteUrl(r.cookies) === null);
  const attempts = buildSetAttempts(c, 'https://www.netflix.com/');
  ok('set attempts built (3+ after dedup)', attempts.length >= 3, `got ${attempts.length}`);
  ok('no attempt carries ";" in value', attempts.every((a) => !a.value.includes(';')));
  ok('attempt value ends 718', attempts.every((a) => a.value.endsWith('718')));
}

console.log('--- chain input (two pairs inside domain field) ---');
{
  const r = parseCookieText(CHAIN_JSON);
  ok('BOTH cookies salvaged', r.cookies.length === 2, `got ${r.cookies.length}`);
  const names = r.cookies.map((c) => c.name);
  ok('names are NetflixId + SecureNetflixId', names.includes('NetflixId') && names.includes('SecureNetflixId'), names.join(','));
  const nid = r.cookies.find((c) => c.name === 'NetflixId');
  ok('NetflixId value clean', nid.value === 'ct%3DBgjAAA', nid.value);
  const sid = r.cookies.find((c) => c.name === 'SecureNetflixId');
  ok('SecureNetflixId value clean', sid.value === 'v%3D3%26mac%3DBBB', sid.value);
}

console.log('--- name/value mismatch salvage (prefers matching pair) ---');
{
  const r = parseCookieText(JSON.stringify([
    { name: 'SecureNetflixId', value: '', domain: 'NetflixId=AAA; SecureNetflixId=BBB' },
  ]));
  const sid = r.cookies.find((c) => c.name === 'SecureNetflixId');
  ok('matching pair preferred', sid && sid.value === 'BBB', JSON.stringify(r.cookies));
}

console.log('--- sanitizeCookieValue units ---');
{
  ok('strips trailing ;', sanitizeCookieValue('abc;') === 'abc');
  ok('cuts glued pair', sanitizeCookieValue('a%3D1; b=2') === 'a%3D1');
  ok('unwraps quotes', sanitizeCookieValue('"quoted"') === 'quoted');
  ok('keeps percent-encoding', sanitizeCookieValue('v%3D3%26mac%3DX.%26dt%3D123') === 'v%3D3%26mac%3DX.%26dt%3D123');
  ok('trims whitespace', sanitizeCookieValue('  abc  ') === 'abc');
  ok('empty stays empty', sanitizeCookieValue('') === '');
  ok('salvagePairs skips junk', salvagePairsFromGarbage('https://evil.com/?x=1; NetflixId=ok').length === 1);
}

console.log('--- native Netflix link paste ---');
const NATIVE_URL = 'https://netflix.com/?nftoken=BgjCwOvcAxLCAfZb9ZB5nsZpTzxwKGIu1ulMUZkZDaBF0RQlvxc' + '/8DrjQQCWv/h/2AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/==';
{
  ok('extractMagicToken ignores native', extractMagicToken(NATIVE_URL) === null);
  const nat = extractNativeLink(NATIVE_URL);
  ok('native detected', !!nat);
  ok('token captured (with + / =)', nat && nat.token.startsWith('BgjCwOvc') && nat.token.includes('+') && nat.token.includes('/'));
  ok('url preserved', nat && nat.url.startsWith('https://netflix.com/?nftoken=BgjCw'));
  const r = parseCookieText(NATIVE_URL);
  ok('URL paste yields 0 garbage cookies', r.cookies.length === 0, `got ${r.cookies.length}`);
  ok('wrapped paste still detected', !!extractNativeLink(NATIVE_URL.replace(/(.{40})/g, '$1\n')));
  ok('BR1 link not misdetected as native', extractNativeLink('https://x.com/?nftoken=BR1.abcDEF123-_') === null);
  ok('short token ignored', extractNativeLink('https://x.com/?nftoken=shorttoken123') === null);
  ok('no token -> null', extractNativeLink('just some text NetflixId=1') === null);
}

console.log('--- regressions: earlier formats unaffected ---');
{
  const netscape = '#HttpOnly_.netflix.com\tTRUE\t/\tTRUE\t1821295654\tNetflixId\tct%3DBgjHlOvc\n.netflix.com\tTRUE\t/\tFALSE\t1820006285\tnfvdid\tBQFmAAEBEE';
  const r = parseCookieText(netscape);
  ok('netscape still parses', r.cookies.length === 2 && r.cookies[0].value === 'ct%3DBgjHlOvc');
  const hdr = parseCookieText('NetflixId=ct%3DAAA; SecureNetflixId=v%3D3%26mac%3DBBB');
  ok('header string still parses', hdr.cookies.length === 2);
  ok('header values survive', hdr.cookies[1].value === 'v%3D3%26mac%3DBBB');
  const junkHeader = parseCookieText('https://netflix.com/?nftoken=BgjCwOvcAxLCAfZb9ZB5nsZpTzxwKGIu1ulMUZkZDaBF0RQlvxc8DrjQQCWv');
  ok('bare URL -> 0 cookies (name guard)', junkHeader.cookies.length === 0, `got ${junkHeader.cookies.length}`);
  const normalJson = parseCookieText(JSON.stringify([{ name: 'sid', value: 'abc', domain: '.example.com' }]));
  ok('normal JSON untouched', normalJson.cookies.length === 1 && normalJson.cookies[0].domain === '.example.com');
  const sessionFlag = parseCookieText(JSON.stringify([{ name: 's', value: 'v', session: true }]));
  ok('session:true still drops expiry', sessionFlag.cookies[0].expirationDate === undefined);
  ok('normalizeUrl still blocks junk hosts', (() => { try { normalizeUrl('https://securenetflixid=v%3D1'); return false; } catch { return true; } })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
