// Prove the BRNT Cookie Bridge extension flow end-to-end with a REAL session
// captured from the deployed console:
//   1. Take the raw cookies the console captured (from /api/replay-cookies).
//   2. Parse them with the extension's actual parser (shared.js).
//   3. Emit the exact Cookie header a browser would send after chrome.cookies.set().
//   4. (curl verification of the welcome page happens in the shell afterwards.)
//
// Run: bun /home/z/my-project/scripts/test-bridge-flow.mjs <cookiesRaw> <targetUrl>

import { parseCookieText, deriveSiteUrl, buildSetAttempts } from '../download/brnt-cookie-bridge/shared.js';

const raw = process.argv[2] || '';
const target = process.argv[3] || '';
if (!raw || !target) {
  console.error('usage: bun test-bridge-flow.mjs "<raw cookies>" "<target url>"');
  process.exit(1);
}

console.log('--- 1. paste into extension popup ---');
console.log(JSON.stringify(raw));

const { format, cookies } = parseCookieText(raw);
console.log('\n--- 2. popup parse result ---');
console.log('format detected :', format);
console.log('cookies parsed  :', cookies.length);
for (const c of cookies) {
  console.log(`  - ${c.name}=${c.value}${c.domain ? ` (domain ${c.domain})` : ' (host-only)'}`);
}

console.log('\n--- 3. site URL auto-fill ---');
console.log(deriveSiteUrl(cookies) || '(none - type manually)');

console.log('\n--- 4. what chrome.cookies.set() will write (first attempt each) ---');
const base = deriveSiteUrl(cookies) || target;
for (const c of cookies) {
  const a = buildSetAttempts(c, base);
  const first = a[0];
  console.log(`  ${first.name} -> ${first.url} secure=${first.secure} httpOnly=${first.httpOnly ?? false} domain=${first.domain || '(host-only)'}`);
}

console.log('\n--- 5. Cookie header the browser will send ---');
console.log(cookies.map((c) => `${c.name}=${c.value}`).join('; '));
