// Real-Chromium test with the FRESH primevideo cookies (Cookie-Editor JSON).
// Decides: tokens dead vs datacenter-IP/bot mitigation.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const raw = JSON.parse(readFileSync('/home/z/my-project/tmp/pv2-cookies.json', 'utf8'));

const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'Asia/Singapore',
  viewport: { width: 1440, height: 900 },
});

await ctx.addCookies(
  raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite === 'lax' ? 'Lax' : c.sameSite === 'strict' ? 'Strict' : c.sameSite === 'no_restriction' ? 'None' : 'Lax',
    expires: c.session || !c.expirationDate ? undefined : c.expirationDate,
  }))
);

const page = await ctx.newPage();

// 1) storefront on the user's region path
const r1 = await page.goto('https://www.primevideo.com/region/eu/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
await page.waitForTimeout(6000);
const html1 = await page.content();
console.log('STEP1 storefront ->', r1 ? `HTTP ${r1.status()}` : 'err', '| url:', page.url().slice(0, 90));
console.log('  isCustomerSecurelyRecognized:', (html1.match(/"isCustomerSecurelyRecognized":(true|false)/) || [])[1] || 'not-found');
console.log('  "Sign in" link:', /sign\s?in/i.test(html1), '| watchlist:', /watchlist/i.test(html1));
const signInHref = (html1.match(/href="([^"]*ap\/signin[^"]*)"/) || [])[1];
console.log('  signin href present:', !!signInHref);

// 2) the user's exact offers target
const r2 = await page.goto('https://www.primevideo.com/offers/nonprimehomepage', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
await page.waitForTimeout(5000);
console.log('STEP2 offers ->', r2 ? `HTTP ${r2.status()}` : 'err', '| final url:', page.url().slice(0, 90));

// 3) auth-decisive: /region/eu/settings
const r3 = await page.goto('https://www.primevideo.com/region/eu/settings', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
console.log('STEP3 settings ->', r3 ? `HTTP ${r3.status()}` : 'err', '| final url:', page.url().slice(0, 110));
const loggedIn = !/ap\/signin|auth-redirect/.test(page.url());
console.log('LOGGED-IN (settings stayed):', loggedIn);

await page.screenshot({ path: '/home/z/my-project/download/pv2-browser-test.png' });
console.log('screenshot: download/pv2-browser-test.png');
await browser.close();
