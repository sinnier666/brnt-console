// T39 v2: extension-aware experiment.
// 1. Local simulator self-test — proves the extension intercept actually runs
//    in THIS harness (rich vs stripped payload) before touching the real site.
// 2. Real primevideo run — only to see whether the extension applies cookies
//    (mechanism); session acceptance is expected OUT if the old capture is dead.

import { chromium } from 'playwright';
import http from 'node:http';
import { buildMagicLink } from '../src/lib/magic-link.ts';

const EXT = '/home/z/my-project/tmp/ext-src/brnt-cookie-bridge';
const PORT = 8944;

const PAIRS = [
  ['at-main-av', 'Atza|gQBD2xUiAwEBAhT-_MxPWKXwww6KnSBv-3WaFTHm523su5ALuXnmkjq0H0uBVJ-8IdBMqmYjzoE4ijj6slqXbuSMc4COhF8ZRQpM8HW5I7lkshnJJFzvVe4aSxA26WbqAh5TbiMMdxfjregC974phYmceGHiJE2gaKfAIuabmHeKklqJaicirxoAwnk_DTK4OJ62g_s0t2yxPWaVP9OPwklxkOrsd5AE8BIGEUbvwvMxNjM01lY9QbdpELAhL3NoRIAPyBBEN3P-dXaJthvmY3IR6viz8j0WOnD2WxCYZZmMmR_pUomMG1DkfFsMpZJjo0A84DhCiYYsNVmm1Zsc-VMisJP7wRwPm463PPntvO3-uxx_UhD2Qj5njWkqz7MizxcoS-niWWCMQEx-od5ljw1_'],
  ['i18n-prefs', 'USD'],
  ['ubid-main-av', '261-2678462-9887354'],
];
const RICH_LOCAL = PAIRS.map(([name, value]) => ({
  name,
  value,
  domain: '.primevideo.com',
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'lax',
  expirationDate: Math.floor(Date.now() / 1000) + 300 * 24 * 3600,
}));
// local variants: cookie domain must match the simulator host to be accepted
const RICH_LOCAL_HOST = PAIRS.map(([name, value]) => ({ ...RICH_LOCAL[PAIRS.findIndex((p) => p[0] === name)], domain: '127.0.0.1' }));
const STRIPPED_LOCAL = PAIRS.map(([name, value]) => ({ name, value }));

// ---------- simulator ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.searchParams.has('nftoken')) {
    // mimic amazon: 302 to the clean home (keeps other params, drops nothing —
    // but the extension should have already stripped/relaoded)
    res.writeHead(302, { Location: `/home?kept=1${u.searchParams.has('nftoken') ? '&hadtoken=1' : ''}` });
    return res.end();
  }
  const cookie = req.headers.cookie || '';
  const has = cookie.includes('at-main-av=');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    `<html><body><h1 id="verdict">${has ? 'LOGGED-IN' : 'LOGGED-OUT'}</h1>` +
      `<p id="cookie">${cookie.replace(/</g, '&lt;')}</p>` +
      `<p id="q">${u.search}</p></body></html>`,
  );
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`simulator on http://127.0.0.1:${PORT}`);

(async () => {
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext('/home/z/my-project/tmp/t39-profile2', {
      channel: 'chromium', // NEW headless — runs MV3 extensions
      headless: true,
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
  } catch (e) {
    console.log('channel chromium failed:', String(e).slice(0, 140));
    ctx = await chromium.launchPersistentContext('/home/z/my-project/tmp/t39-profile2', {
      headless: false,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
  }

  // wait for the MV3 service worker
  let sw = ctx.serviceWorkers().find((s) => s.url().includes('background.js'));
  if (!sw) {
    try {
      sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 });
    } catch {
      /* none */
    }
  }
  console.log('extension SW:', sw ? sw.url() : 'NOT RUNNING !!!');
  if (sw) {
    const ver = await sw.evaluate(() => chrome.runtime.getManifest().version);
    console.log('extension version:', ver);
  }

  // ---------- local self-tests ----------
  const localCases = [
    { id: 'L1-rich', cookies: RICH_LOCAL_HOST, target: `http://127.0.0.1:${PORT}/home` },
    { id: 'L2-stripped', cookies: STRIPPED_LOCAL, target: `http://127.0.0.1:${PORT}/home` },
  ];
  for (const t of localCases) {
    await ctx.clearCookies();
    const built = await buildMagicLink(t.target, t.cookies);
    const page = await ctx.newPage();
    await page.goto(built.link, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const verdict = await page.locator('#verdict').textContent().catch(() => '?');
    const q = await page.locator('#q').textContent().catch(() => '?');
    const url = page.url();
    console.log(`\n[${t.id}] token ${built.encoded} ${built.count}c`);
    console.log(`  verdict: ${verdict} | url: ${url.slice(0, 80)} | q: ${q}`);
    console.log(`  ${verdict === 'LOGGED-IN' && !url.includes('nftoken') ? 'INTERCEPT WORKS ✔' : 'INTERCEPT FAILED ✘'}`);
    await page.close();
  }

  // ---------- real site: mechanism-only check ----------
  const RICH_REAL = [
    { name: 'i18n-prefs', value: 'USD', domain: '.primevideo.com', path: '/', secure: true, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 86400 * 300 },
    { name: 'ubid-main-av', value: '261-2678462-9887354', domain: '.primevideo.com', path: '/', secure: true, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 86400 * 300 },
  ];
  const realCases = [
    { id: 'R1-rich', cookies: RICH_REAL, target: 'https://www.primevideo.com/' },
    { id: 'R2-stripped', cookies: RICH_REAL.map(({ name, value }) => ({ name, value })), target: 'https://www.primevideo.com/' },
  ];
  for (const t of realCases) {
    await ctx.clearCookies();
    const built = await buildMagicLink(t.target, t.cookies);
    const page = await ctx.newPage();
    await page.goto(built.link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(8000);
    const dc = await page.evaluate(() => document.cookie).catch(() => '');
    const applied = dc.includes('i18n-prefs') || dc.includes('ubid-main-av');
    console.log(`\n[${t.id}] real primevideo — extension applied: ${applied ? 'YES ✔' : 'NO ✘'} | landed: ${page.url().slice(0, 80)}`);
    await page.close();
  }

  await ctx.close();
  server.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
