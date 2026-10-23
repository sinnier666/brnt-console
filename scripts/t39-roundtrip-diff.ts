// T39: deterministic diff — dialog payload vs panel payload for the SAME cookies.
// Dialog: buildMagicLink(target, RICH jar objects)
// Panel:  buildMagicLink(target, cookiesFromSource(toHeader(RICH)))  [live-sessions round-trip]
import { buildMagicLink, decodeMagicToken } from "../src/lib/magic-link.ts";
import { toHeader, cookiesFromSource } from "../src/lib/session-export.ts";

const RICH = [
  { name: "at-main-av", value: "Atza|gQBD2xUiAwEBAhT-_MxP", domain: ".primevideo.com", path: "/", secure: true, httpOnly: false, sameSite: "lax", expirationDate: 1900000000 },
  { name: "sess-at-main-av", value: "riLxlzE8cXMtCP3eYt6lDD0rfLKT+ooR1zZ0sNwsqEM=", domain: ".primevideo.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1900000000 },
  { name: "session-token", value: '"5wsOv67txyk3THDAeKDX/tdDC0XlNkl/r/WIjXXdR1lMlZ"', domain: ".primevideo.com", path: "/", secure: true, httpOnly: false, sameSite: "lax", expirationDate: 1900000000 },
  { name: "x-main-av", value: '"fWQKWW?rRqwCNC4Hpcm6KUQGLOI3dCAtACKK6e0LY47B0jBerfbAcedBJU?vjwOu"', domain: ".primevideo.com", path: "/", secure: true, httpOnly: false, sameSite: "lax", expirationDate: 1900000000 },
];
const TARGET = "https://www.primevideo.com/offers/nonprimehomepage";

const d = await buildMagicLink(TARGET, RICH);
const p = await buildMagicLink(TARGET, cookiesFromSource(toHeader(RICH)));

const dd = await decodeMagicToken(d.link.match(/nftoken=(.*)$/)[1]);
const dp = await decodeMagicToken(p.link.match(/nftoken=(.*)$/)[1]);

console.log("dialog payload cookies:");
for (const c of dd.c) console.log(`  ${c.n} = ${String(c.v).slice(0, 34)}… d=${c.d ?? "-"} s=${c.s ?? 0} h=${c.h ?? 0} e=${c.e ?? "-"}`);
console.log("panel payload cookies:");
for (const c of dp.c) console.log(`  ${c.n} = ${String(c.v).slice(0, 34)}… d=${c.d ?? "-"} s=${c.s ?? 0} h=${c.h ?? 0} e=${c.e ?? "-"}`);

const norm = (arr) => JSON.stringify(arr.map((c) => [c.n, c.v, c.d ?? "", c.s ?? 0, c.h ?? 0, c.e ?? ""]));
console.log("\nVALUES+METADATA IDENTICAL:", norm(dd.c) === norm(dp.c));
