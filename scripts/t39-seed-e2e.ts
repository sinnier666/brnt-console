// T39 E2E seed: create a REAL replay session (fresh jar marker "v2-jar-freshest")
// + a live panel entry whose stored cookieObjs carry a STALE marker ("v1-stored").
// The browser open must refetch via sessionId -> the built token must carry the
// v2 value AND the .primevideo.com domain.
// Run: bun scripts/t39-seed-e2e.ts   (prints JSON state)

import { CookieJar } from "../src/lib/cookies.ts";
import { createSession } from "../src/lib/session-store.ts";

const BASE = "http://localhost:3000";
const ADMIN_KEY = "brnt-admin";
const TARGET = "https://www.primevideo.com/offers/nonprimehomepage";

const RICH = [
  { name: "at-main-av", value: "v2-jar-freshest", domain: ".primevideo.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1900000000 },
  { name: "i18n-prefs", value: "USD", domain: ".primevideo.com", path: "/", secure: true },
  { name: "ubid-main-av", value: "261-2678462-9887354", domain: ".primevideo.com", path: "/", secure: true },
];

const jar = new CookieJar();
jar.seedParsed(RICH, "www.primevideo.com");
const session = await createSession(TARGET, jar);
console.log(JSON.stringify({ sessionCreated: true, sessionId: session.id }));

const res = await fetch(`${BASE}/api/live-sessions`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-brnt-admin": ADMIN_KEY },
  body: JSON.stringify({
    cookies: RICH.map((c) => `${c.name}=${c.value}`).join("; ").replace("v2-jar-freshest", "v1-stored"),
    cookieObjs: RICH.map((c) => ({ ...c, value: c.value === "v2-jar-freshest" ? "v1-stored" : c.value })),
    sessionId: session.id,
    target: TARGET,
    label: "t39 e2e primevideo",
  }),
});
const j = await res.json();
console.log(JSON.stringify({ liveAdded: j?.ok, liveId: j?.record?.id, host: j?.record?.host, storedCookie0: j?.record?.cookies?.[0] }));
if (!j?.ok) process.exit(1);
