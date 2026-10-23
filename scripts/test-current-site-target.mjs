#!/usr/bin/env node
// Task 32: v1.6.0 "current page site + one-click import" targeting tests.
// The popup no longer has a "Site to open" field; resolveImportTarget()
// decides where cookies go from the ACTIVE TAB + cookie domains.
// Run: node /home/z/my-project/scripts/test-current-site-target.mjs
import {
  resolveImportTarget,
  parseCookieText,
} from '../download/brnt-cookie-bridge/shared.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n    expected: ${e}\n    actual:   ${a}`); }
}

const NF_NETSCAPE = [
  '# Netscape HTTP Cookie File',
  '.netflix.com\tTRUE\t/\tTRUE\t1999999999\tNetflixId\tNFID-VALUE',
  '.netflix.com\tTRUE\t/\tTRUE\t1999999999\tSecureNetflixId\tSNID-VALUE',
  '#HttpOnly_.netflix.com\tTRUE\t/\tTRUE\t1999999999\tnfvdid\tNFC-VALUE',
].join('\n');
const nfCookies = parseCookieText(NF_NETSCAPE).cookies;

// 1) Sitting on the site -> one click reloads the SAME tab
eq(
  resolveImportTarget({ magicUrl: null, activeTabUrl: 'https://www.netflix.com/browse', cookies: nfCookies }),
  { url: 'https://www.netflix.com/', mode: 'current-tab', matched: true, reason: 'current tab matches the cookie domain' },
  'tab on www.netflix.com + netflix cookies -> current-tab reload'
);

// 1b) apex host, parent-domain cookie
eq(
  resolveImportTarget({ magicUrl: null, activeTabUrl: 'https://netflix.com/', cookies: nfCookies }).matched,
  true,
  'tab on apex netflix.com matches .netflix.com cookies'
);

// 1c) subdomain cookie matches deeper tab host
eq(
  resolveImportTarget({ magicUrl: null, activeTabUrl: 'https://www.netflix.com/browse', cookies: [{ name: 'x', value: 'y', domain: '.www.netflix.com' }] }).matched,
  true,
  'tab www.netflix.com matches .www.netflix.com cookie'
);

// 2) On a different site -> auto-derive the cookie site, new tab
eq(
  resolveImportTarget({ magicUrl: null, activeTabUrl: 'https://www.google.com/search?q=x', cookies: nfCookies }),
  { url: 'https://netflix.com/', mode: 'new-tab', matched: false, reason: 'current tab is a different site - cookies go to their own site in a new tab' },
  'tab on google.com + netflix cookies -> new tab at netflix'
);

// 3) chrome:// new-tab page -> derived site, new tab
eq(
  resolveImportTarget({ magicUrl: null, activeTabUrl: 'chrome://new-tab-page/', cookies: nfCookies }),
  { url: 'https://netflix.com/', mode: 'new-tab', matched: false, reason: 'current tab is not a website - opening the cookie site' },
  'chrome:// tab + netflix cookies -> new tab at netflix'
);

// 3b) empty active tab
eq(
  resolveImportTarget({ magicUrl: null, activeTabUrl: '', cookies: nfCookies }).url,
  'https://netflix.com/',
  'no tab url + netflix cookies -> derived netflix'
);

// 4) Host-only cookies (header paste, no domains) + user on the site -> current tab
const hdr = parseCookieText('sid=abc123; theme=dark').cookies;
eq(
  resolveImportTarget({ magicUrl: null, activeTabUrl: 'https://app.example.com/dashboard', cookies: hdr }),
  { url: 'https://app.example.com/', mode: 'current-tab', matched: true, reason: 'cookies carry no domain - they will be set for the current tab' },
  'host-only cookies -> current tab wins'
);

// 4b) Host-only cookies on a chrome:// tab -> unresolvable, clear reason
const noTab = resolveImportTarget({ magicUrl: null, activeTabUrl: 'chrome://version/', cookies: hdr });
eq(noTab.url, null, 'host-only cookies + chrome:// tab -> no target');
okContains(noTab.reason, 'open the site in a tab first', 'reason tells the user what to do');

// 5) Magic link wins and is the target; same-host tab reloads
eq(
  resolveImportTarget({ magicUrl: 'https://www.netflix.com/browse', activeTabUrl: 'https://www.netflix.com/', cookies: [] }),
  { url: 'https://www.netflix.com/', mode: 'current-tab', matched: true, reason: 'current tab is the magic-link site' },
  'magic link + tab already on that site -> reload current tab'
);
eq(
  resolveImportTarget({ magicUrl: 'https://www.primevideo.com/', activeTabUrl: 'https://www.netflix.com/', cookies: [] }),
  { url: 'https://www.primevideo.com/', mode: 'new-tab', matched: false, reason: 'magic-link site differs from the current tab' },
  'magic link for another site -> new tab'
);

// 6) Cookies override a NON-matching tab even when the tab is http(s)
//    (header cookies on the wrong site + domain cookies present)
eq(
  resolveImportTarget({ magicUrl: null, activeTabUrl: 'https://example.org/', cookies: nfCookies }).url,
  'https://netflix.com/',
  'tab on unrelated site still yields the cookie site'
);

// 7) Garbage domains never poison the target (v1.3 repair carries over)
const mangled = parseCookieText(JSON.stringify([
  { name: 'NetflixId', value: 'NFID', domain: 'NetflixId=NFID; SecureNetflixId=SNID' },
]));
eq(
  resolveImportTarget({ magicUrl: null, activeTabUrl: 'https://www.netflix.com/', cookies: mangled.cookies }).matched,
  true,
  'garbage-domain export (host-only after repair) still targets the current netflix tab'
);

function okContains(hay, needle, label) {
  if (String(hay).includes(needle)) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} - "${hay}" does not contain "${needle}"`); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
