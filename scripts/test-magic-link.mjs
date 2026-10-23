// Magic link (nftoken) codec + flow tests — run with: bun scripts/test-magic-link.mjs
// Tests BOTH implementations:
//   encode: src/lib/magic-link.ts  (console)
//   decode: download/brnt-cookie-bridge/shared.js  (extension background)

import { decodeMagicToken, buildSetAttempts } from "../download/brnt-cookie-bridge/shared.js";
import {
  buildMagicLink,
  compactCookies,
  encodeMagicToken,
  decodeMagicToken as decodeTs,
} from "../src/lib/magic-link.ts";
import zlib from "node:zlib";

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log("  ✓ " + label);
  } else {
    fail++;
    console.log("  ✗ FAIL: " + label);
  }
}

const NETFLIX_HEADER =
  "NetflixId=v%3D2%26ct%3DBQABAAAAAAmqFbr8rRnHd5eN1s9k3JpQ7TzK2LbXcVfGhYjKlMnOpQrStUvWxYz0123456789;" +
  " SecureNetflixId=v%3D2%26ct%3DBQABAAAAAASecureNetflixIdValueWithMoreEntropy1234567890abcdefghij;" +
  " nfvdid=308F3A2E-9C1B-4A2D-8E3F-123456789ABC;" +
  " flwssn=FLWSSN-VALUE-8827;" +
  " csfid=CSRF-ID-EXAMPLE-4410;" +
  " csm-hit=tb%3Asomeid%7C1792723000000";

async function main() {
  console.log("\n== 1. buildMagicLink: basic shape ==");
  const built = await buildMagicLink("https://www.netflix.com/ph-en/", NETFLIX_HEADER);
  ok(built.link.startsWith("https://www.netflix.com/ph-en/?nftoken=BR"), "link = https://www.netflix.com/ph-en/?nftoken=BR…");
  const token = built.link.split("nftoken=")[1];
  ok(/^BR[01]\.[A-Za-z0-9\-_]+$/.test(token), `token URL-safe (${built.encoded}, ${built.link.length} chars)`);
  ok(built.count === 6, `6 cookies encoded (got ${built.count})`);
  ok(built.link.length < 8000, `link shorter than 8000 chars (${built.link.length})`);

  console.log("\n== 2. Roundtrip: extension decoder (shared.js) ==");
  const payload = await decodeMagicToken(token);
  ok(!!payload, "decodeMagicToken returns payload");
  ok(payload && payload.u === "https://www.netflix.com/ph-en/", "payload.u preserved");
  ok(payload && payload.c.length === 6, "6 cookies decoded");
  const netflixId = payload && payload.c.find((c) => c.name === "NetflixId");
  ok(
    netflixId &&
      netflixId.value ===
        "v%3D2%26ct%3DBQABAAAAAAmqFbr8rRnHd5eN1s9k3JpQ7TzK2LbXcVfGhYjKlMnOpQrStUvWxYz0123456789",
    "NetflixId value exact roundtrip"
  );
  const tsDecoder = await decodeTs(token);
  ok(tsDecoder && tsDecoder.c.length === payload.c.length, "console decoder agrees with extension decoder");

  console.log("\n== 3. Old nftoken param replaced, other params kept ==");
  const built2 = await buildMagicLink("https://www.netflix.com/?nftoken=OLDBUTGOLD&foo=bar", NETFLIX_HEADER);
  ok(!built2.link.includes("OLDBUTGOLD"), "stale nftoken dropped");
  ok(built2.link.includes("foo=bar"), "other query params kept");
  ok(built2.link.includes("nftoken=BR"), "fresh nftoken present");

  console.log("\n== 4. compactCookies: dedupe + expiry ms→s + flags ==");
  const comp = compactCookies([
    { name: "a", value: "first" },
    { name: "a", value: "second" },
    { name: "b", value: "v", domain: ".example.com", httpOnly: true, secure: true, sameSite: "no_restriction" },
    { name: "c", value: "v", expirationDate: 1799999999999 },
    { name: "d", value: "session", expirationDate: -1 },
  ]);
  ok(comp.length === 4, "duplicate name collapsed (first wins)");
  ok(comp[0].n === "a" && comp[0].v === "first", "first occurrence kept");
  ok(comp[1].d === ".example.com" && comp[1].h === 1 && comp[1].s === 1 && comp[1].ss === "no_restriction", "domain/httpOnly/secure/sameSite flags kept");
  ok(comp[2].e === 1799999999 + (1799999999999 % 1 === 0 ? 0 : 0) || Math.abs(comp[2].e - 1799999999.999) < 1, "ms expiry converted to seconds");
  ok(comp[3].e === undefined, "negative expiry dropped (session cookie)");

  console.log("\n== 5. BR1 token built by zlib decodes via DecompressionStream ==");
  const json = JSON.stringify({ v: 1, u: "https://example.com/", c: [{ n: "k", v: "val+ue/with specials", d: ".example.com" }] });
  const z = zlib.deflateRawSync(Buffer.from(json));
  const b64 = z.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const manual = await decodeMagicToken("BR1." + b64);
  ok(!!manual, "zlib-built BR1 token decoded");
  ok(manual && manual.c[0].name === "k" && manual.c[0].value === "val+ue/with specials", "special characters roundtrip (expanded name/value)");

  console.log("\n== 6. Invalid tokens rejected ==");
  ok((await decodeMagicToken("")) === null, "empty → null");
  ok((await decodeMagicToken("notatoken")) === null, "garbage → null");
  ok((await decodeMagicToken("BR2.abcabc")) === null, "unknown version → null");
  ok((await decodeMagicToken("BR1.!!!invalid!!!")) === null, "bad charset → null");

  console.log("\n== 7. Extension apply path: decoded cookie → chrome.cookies.set details ==");
  const attempts = buildSetAttempts(payload.c.find((c) => c.name === "NetflixId"), "https://www.netflix.com/");
  ok(attempts.length >= 3, `fallback chain built (${attempts.length} unique attempts)`);
  ok(attempts[0].domain === undefined, "header-source cookie falls back to host-only via baseUrl host");

  console.log("\n== 8. JSON-source input works too ==");
  const jsonInput = JSON.stringify([
    { name: "NetflixId", value: "abc123", domain: ".netflix.com", path: "/", secure: true, httpOnly: true, sameSite: "lax" },
    { name: "nfvdid", value: "DEF456", domain: ".netflix.com", secure: true },
  ]);
  const built3 = await buildMagicLink("https://www.netflix.com/", jsonInput);
  const p3 = await decodeMagicToken(built3.link.split("nftoken=")[1]);
  ok(p3 && p3.c.length === 2, "Cookie-Editor JSON input encoded");
  ok(p3 && p3.c[0].domain === ".netflix.com" && p3.c[0].httpOnly === true && p3.c[0].sameSite === "lax", "domain + httpOnly + sameSite survive");
  const att3 = buildSetAttempts(p3.c[0], "https://www.netflix.com/");
  ok(att3[0].domain === ".netflix.com" && att3[0].httpOnly === true, "set-details carry domain + httpOnly");

  console.log("\n== 9. Full server roundtrip (dev server) ==");
  try {
    const accRes = await fetch("http://localhost:3000/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "generate", adminKey: "brnt-admin", days: 1 }),
    });
    const acc = await accRes.json();
    ok(accRes.ok && acc.record, "access key minted: " + (acc.record ? acc.record.code : "?" ));

    const chkRes = await fetch("http://localhost:3000/api/check-login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-brnt-access": acc.record.code },
      body: JSON.stringify({ url: "http://localhost:3000/api/mock-login", username: "alice", password: "wonderland" }),
    });
    const result = await chkRes.json();
    ok(chkRes.ok && result.verdict === "success", `mock check verdict=success (got ${result.verdict})`);
    ok(!!result.sessionId, "sessionId issued: " + (result.sessionId || "").slice(0, 8) + "…");

    const jarRes = await fetch(`http://localhost:3000/api/replay-cookies/${result.sessionId}`);
    const jar = await jarRes.json();
    ok(jar && jar.cookies && String(jar.cookies).includes("mock_session=valid-alice"), "replay jar has mock_session=valid-alice");
    ok(Array.isArray(jar.jar) && jar.jar.length > 0, "full jar array exposed (attributes intact)");

    const built4 = await buildMagicLink(result.finalUrl || "http://localhost:3000/api/mock-login", jar.jar?.length ? jar.jar : jar.cookies);
    const p4 = await decodeMagicToken(built4.link.split("nftoken=")[1]);
    ok(p4 && p4.c.some((c) => c.name === "mock_session" && c.value === "valid-alice"), "magic link carries the live session cookie");
    ok(p4 && p4.c[0].httpOnly === true, "httpOnly flag from Set-Cookie preserved");
    console.log(`  ℹ sample magic link (${built4.link.length} chars):`);
    console.log("    " + built4.link.slice(0, 160) + "…");
  } catch (e) {
    fail++;
    console.log("  ✗ FAIL: server roundtrip — " + (e && e.message));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
