// Test the user's primevideo.com cookies in a REAL Chromium browser
// (proper TLS fingerprint) to determine: dead cookies vs bot-detection.
// Run: node /home/z/my-project/scripts/pv-browser-test.mjs

import { chromium } from 'playwright';

const TARGET = 'https://www.primevideo.com/offers/nonprimehomepage';

const PAIRS = [
  ['at-main-av', 'Atza|gQBD2xUiAwEBAhT-_MxPWKXwww6KnSBv-3WaFTHm523su5ALuXnmkjq0H0uBVJ-8IdBMqmYjzoE4ijj6slqXbuSMc4COhF8ZRQpM8HW5I7lkshnJJFzvVe4aSxA26WbqAh5TbiMMdxfjregC974phYmceGHiJE2gaKfAIuabmHeKklqJaicirxoAwnk_DTK4OJ62g_s0t2yxPWaVP9OPwklxkOrsd5AE8BIGEUbvwvMxNjM01lY9QbdpELAhL3NoRIAPyBBEN3P-dXaJthvmY3IR6viz8j0WOnD2WxCYZZmMmR_pUomMG1DkfFsMpZJjo0A84DhCiYYsNVmm1Zsc-VMisJP7wRwPm463PPntvO3-uxx_UhD2Qj5njWkqz7MizxcoS-niWWCMQEx-od5ljw1_'],
  ['i18n-prefs', 'USD'],
  ['lc-main-av', 'fr_FR'],
  ['sess-at-main-av', 'riLxlzE8cXMtCP3eYt6lDD0rfLKT+ooR1zZ0sNwsqEM='],
  ['session-id-time', '2082787201l'],
  ['ubid-main-av', '261-2678462-9887354'],
  ['sst-main-av', 'Sst1|PQJEqp_0MBL9XRqKQfsG7JbHB6GAWtsdvloSaXu3U7XKn2CKCWLAD-X2thROFI1IDqW_CKoR2RpSTnyZYEviMC5d2CVccSMZOJJsyxfh0Njzh0mewdfT9SV_n8znrpIjp1BKZneDDI3RKdUi0z19rENkNK47tDhXcCQGPaQApdlYeDrU-4ZtfDsd7KHSQE108AvZ2FilPD6CMxzzU4o1YW81kvNYd4ZgqEym5WGXk7Lz3HR-m-RER4gb7sdf_q5RCRia'],
  ['av-timezone', 'Europe/Paris'],
  ['av-profile', 'cGlkPWFtem4xLmFjdG9yLnBlcnNvbi5vaWQuQTNVVUs3QzcxT0lBWDAmdGltZXN0YW1wPTE3ODIxMTM0NTQxNTUmdmVyc2lvbj12MQ.g5rVVuXvfe1O8pozLRu92l7p9gY2Wrl4hs8tGYuGjegjAAAAAQAAAABqOOSucmF3AAAAAPgWC9WfHH8iB-olH_E9xQ'],
  ['csm-hit', 'tb:W0QVSBXHNQ3TWM3YWD54+s-N0R1TT32DNFQJKSX5Q13|1781552074480&t:1782113455794&adb:adblk_no'],
  ['session-id', '262-2437939-5082132'],
  ['session-token', '"5wsOv67txyk3THDAeKDX/tdDC0XlNkl/r/WIjXXdR1lMlZtjeafJFB/m9y2L7Hdh89LPiVBGN+pXsm32CcZfcBJ4JcMcL29cI2kEgFSALATx2EBY2kIHBL5HTsAvebgHlURXGtlz4NAatHyeL43vsyXH0ltg64lBu5+3lHQI+oxqxVlLxsSnbDvhR3EbFQM+pSmLlZ3LgPRIl/kWoX+98eahqK9rdffRMs1V5MByJcYKqMydSVox81NHQL0Bu+VKST9V6oZNnIw="'],
  ['x-main-av', '"fWQKWW?rRqwCNC4Hpcm6KUQGLOI3dCAtACKK6e0LY47B0jBerfbAcedBJU?vjwOu"'],
];

function cookieVal(v) {
  // unquote values that carry literal quotes from the export
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    viewport: { width: 1440, height: 900 },
  });

  const cookies = PAIRS.map(([name, value]) => ({
    name,
    value: cookieVal(value),
    domain: '.primevideo.com',
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'Lax',
  }));
  await ctx.addCookies(cookies);

  const page = await ctx.newPage();

  // 1) auth-sensitive probe: /settings (redirects to auth when logged out)
  const resp = await page.goto('https://www.primevideo.com/settings', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => null);
  const url1 = page.url();
  console.log('STEP1 /settings ->', resp ? `HTTP ${resp.status()}` : 'nav-error', '| final url:', url1.slice(0, 110));
  const loggedIn = !/auth-redirect|\/auth\b|signin/.test(url1);
  console.log('logged-in by redirect test:', loggedIn);

  // 2) the requested offers page
  const resp2 = await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
  console.log('STEP2 offers page ->', resp2 ? `HTTP ${resp2.status()}` : 'nav-error', '| final url:', page.url().slice(0, 110));
  await page.waitForTimeout(4000);
  const html = await page.content();
  const markers = {
    signInLink: /sign\s?in/i.test(html),
    profileAvatarImg: /avatar|profile-image/i.test(html),
    customerOid: /A3VUUK7C71OIAX0/.test(html),
    securelyRecognized: (html.match(/"isCustomerSecurelyRecognized":(true|false)/) || [])[1] || 'not-found',
    subtitleWatchlist: /watchlist/i.test(html),
  };
  console.log('STEP2 markers:', JSON.stringify(markers));
  const title = await page.title().catch(() => '');
  console.log('STEP2 title:', title.slice(0, 100));

  await page.screenshot({ path: '/home/z/my-project/download/pv-browser-test.png', fullPage: false });
  console.log('screenshot: /home/z/my-project/download/pv-browser-test.png');

  await browser.close();
})();
