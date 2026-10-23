#!/usr/bin/env node
// Task 35 — live sessions panel + usage log: member/admin permissions, add &
// remove live cookies, member apply records, member clear-own, admin download
// and clear by date.

const BASE = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_KEY = "brnt-admin";
const ADMIN_H = { "content-type": "application/json", "x-brnt-admin": ADMIN_KEY };

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ok ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name} ${extra}`);
  }
}

async function jfetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  let j = null;
  try {
    j = await res.json();
  } catch {}
  return { res, j };
}

async function main() {
  // mint a fresh member key
  const mint = await jfetch("/api/access", {
    method: "POST",
    headers: ADMIN_H,
    body: JSON.stringify({ action: "generate", adminKey: ADMIN_KEY, days: 1, note: "t35 panel" }),
  });
  const CODE = mint.j?.record?.code || "";
  ok("minted member key", Boolean(CODE), JSON.stringify(mint.j));
  const MEMBER_H = { "content-type": "application/json", "x-brnt-access": CODE };

  // --- live sessions permissions ---
  const anon = await jfetch("/api/live-sessions");
  ok("anon GET live-sessions -> 403", anon.res.status === 403);

  const asMember = await jfetch("/api/live-sessions", { headers: MEMBER_H });
  ok("member GET live-sessions -> ok", asMember.res.ok && Array.isArray(asMember.j?.sessions));

  const memberAdd = await jfetch("/api/live-sessions", {
    method: "POST",
    headers: MEMBER_H,
    body: JSON.stringify({ cookies: "x=y", target: "https://netflix.com" }),
  });
  ok("member POST live-sessions -> 403", memberAdd.res.status === 403);

  const noCookies = await jfetch("/api/live-sessions", {
    method: "POST",
    headers: ADMIN_H,
    body: JSON.stringify({ cookies: "   " }),
  });
  ok("admin POST without cookies -> 400", noCookies.res.status === 400);

  const junk = await jfetch("/api/live-sessions", {
    method: "POST",
    headers: ADMIN_H,
    body: JSON.stringify({ cookies: "!!!not cookies!!!" }),
  });
  ok("admin POST garbage cookies -> 400", junk.res.status === 400, JSON.stringify(junk.j));

  // --- add via admin (auto-derived site from Netflix cookies) ---
  const add = await jfetch("/api/live-sessions", {
    method: "POST",
    headers: ADMIN_H,
    body: JSON.stringify({
      cookies: "NetflixId=v2%3Atest-value; SafeNetflix=abc123",
      label: "t35 e2e",
    }),
  });
  ok("admin add live session -> ok", add.res.ok && add.j?.ok, JSON.stringify(add.j));
  const sess = add.j?.record;
  ok("derived host is netflix.com", /(^|\.)netflix\.com$/.test(String(sess?.host)), String(sess?.host));
  ok("cookieHeader normalized", String(sess?.cookieHeader || "").startsWith("NetflixId="), sess?.cookieHeader);

  const list2 = await jfetch("/api/live-sessions", { headers: MEMBER_H });
  const found = (list2.j?.sessions || []).find((s) => s.id === sess?.id);
  ok("member sees the new session", Boolean(found));

  // --- usage log: member records an apply ---
  const rec = await jfetch("/api/usage-log", {
    method: "POST",
    headers: MEMBER_H,
    body: JSON.stringify({ action: "nft-open", site: "netflix.com", cookieHeader: "NetflixId=v2%3Atest-value; SafeNetflix=abc123" }),
  });
  ok("member record apply -> ok", rec.res.ok && rec.j?.ok, JSON.stringify(rec.j));

  const rec2 = await jfetch("/api/usage-log", {
    method: "POST",
    headers: MEMBER_H,
    body: JSON.stringify({ action: "cookies-download", site: "netflix.com", cookieHeader: "NetflixId=v2%3Atest-value" }),
  });
  ok("member record download -> ok", rec2.res.ok);

  const mine = await jfetch("/api/usage-log?mine=1", { headers: MEMBER_H });
  const mineOk = mine.res.ok && (mine.j?.entries || []).some((e) => e.action === "nft-open" && e.member === CODE);
  ok("member sees own records", mineOk, JSON.stringify(mine.j)?.slice(0, 200));
  ok("records contain the applied cookie header", (mine.j?.entries || []).some((e) => String(e.cookieHeader || "").includes("NetflixId")));

  // --- usage log permissions ---
  const anonMine = await jfetch("/api/usage-log?mine=1");
  ok("anon ?mine=1 -> 403", anonMine.res.status === 403);
  const memberList = await jfetch("/api/usage-log?list=1", { headers: MEMBER_H });
  ok("member ?list=1 -> 403", memberList.res.status === 403);
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const memberDl = await fetch(`${BASE}/api/usage-log?date=${today}`, { headers: MEMBER_H });
  ok("member download by date -> 403", memberDl.status === 403);

  const adminList = await jfetch("/api/usage-log?list=1", { headers: ADMIN_H });
  ok("admin ?list=1 -> ok with today", adminList.res.ok && (adminList.j?.dates || []).some((d) => d.date === today), JSON.stringify(adminList.j));

  const adminDl = await fetch(`${BASE}/api/usage-log?date=${today}`, { headers: { "x-brnt-admin": ADMIN_KEY } });
  const txt = await adminDl.text();
  ok("admin downloads today's .txt", adminDl.ok && txt.includes(`member=${CODE}`) && txt.includes("nft-open"), txt.slice(0, 150));
  ok("download has .txt disposition", (adminDl.headers.get("content-disposition") || "").includes(`brnt-usage-${today}.txt`));

  // --- member clear-own ---
  const clear = await jfetch("/api/usage-log", { method: "DELETE", headers: MEMBER_H });
  ok("member clear-own -> removed >=2", clear.res.ok && (clear.j?.removed || 0) >= 2, JSON.stringify(clear.j));
  const mine2 = await jfetch("/api/usage-log?mine=1", { headers: MEMBER_H });
  ok("own records gone after clear", (mine2.j?.entries || []).length === 0);

  // --- admin clear by date (fabricated date so real logs stay intact) ---
  const { promises: fs } = await import("fs");
  const path = `${process.cwd()}/.data/logs/usage-2030-01-01.txt`;
  await fs.mkdir(`${process.cwd()}/.data/logs`, { recursive: true });
  await fs.writeFile(
    path,
    "[2030-01-01T00:00:00.000Z] member=BRNT-TEST-TEST action=nft-open site=netflix.com cookies=1 [NetflixId] | header: NetflixId=x\n".repeat(3),
    "utf8"
  );
  const clearDate = await jfetch("/api/usage-log?date=2030-01-01", { method: "DELETE", headers: ADMIN_H });
  ok("admin clear by date -> removed 3", clearDate.res.ok && clearDate.j?.removed === 3, JSON.stringify(clearDate.j));
  const gone = await fs.readFile(path, "utf8").then(() => false).catch(() => true);
  ok("date file removed after clear", gone);

  const memberClearAll = await jfetch("/api/usage-log?all=1", { method: "DELETE", headers: MEMBER_H });
  ok("member cannot clear all", memberClearAll.res.status === 403);

  // --- remove live session ---
  const memberRm = await jfetch(`/api/live-sessions?id=${sess?.id}`, { method: "DELETE", headers: MEMBER_H });
  ok("member DELETE live session -> 403", memberRm.res.status === 403);
  const adminRm = await jfetch(`/api/live-sessions?id=${sess?.id}`, { method: "DELETE", headers: ADMIN_H });
  ok("admin DELETE live session -> ok", adminRm.res.ok);
  const list3 = await jfetch("/api/live-sessions", { headers: MEMBER_H });
  ok("session gone from the list", !(list3.j?.sessions || []).some((s) => s.id === sess?.id));

  // --- t39: rich cookies + source session on live entries (panel == dialog payloads) ---
  const RICH = [
    { name: "at-main-av", value: "Atza|t39-value", domain: ".primevideo.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1900000000 },
    { name: "i18n-prefs", value: "USD", domain: ".primevideo.com", path: "/", secure: true },
    { name: "bad name", value: "dropped" }, // space = invalid cookie name, must be filtered
  ];
  const richAdd = await jfetch("/api/live-sessions", {
    method: "POST",
    headers: ADMIN_H,
    body: JSON.stringify({
      cookies: "at-main-av=Atza|t39-value; i18n-prefs=USD",
      cookieObjs: RICH,
      sessionId: "t39-probe-session",
      target: "https://www.primevideo.com/offers/nonprimehomepage",
      label: "t39 rich",
    }),
  });
  ok("t39 admin add with cookieObjs -> ok", richAdd.res.ok && richAdd.j?.ok, JSON.stringify(richAdd.j));
  const richRec = richAdd.j?.record;
  ok("t39 record.cookies preserved with domains", Array.isArray(richRec?.cookies) && richRec.cookies[0]?.domain === ".primevideo.com", JSON.stringify(richRec?.cookies));
  ok("t39 record.cookies keeps secure+httpOnly", richRec?.cookies?.[0]?.secure === true && richRec?.cookies?.[0]?.httpOnly === true);
  ok("t39 record.cookies filters junk names", richRec?.cookies?.length === 2);
  ok("t39 record.sessionId stored", richRec?.sessionId === "t39-probe-session");
  ok("t39 record.cookieHeader still present", typeof richRec?.cookieHeader === "string" && richRec.cookieHeader.includes("at-main-av=Atza|t39-value"));

  const legacyAdd = await jfetch("/api/live-sessions", {
    method: "POST",
    headers: ADMIN_H,
    body: JSON.stringify({ cookies: "NetflixId=v2%3At39legacy; SafeNetflix=x", label: "t39 legacy" }),
  });
  const legacyRec = legacyAdd.j?.record;
  ok("t39 legacy add still ok", legacyAdd.res.ok && legacyAdd.j?.ok);
  ok("t39 legacy header-only entry still lists", Boolean(legacyRec?.id) && typeof legacyRec?.cookieHeader === "string");

  const richList = await jfetch("/api/live-sessions", { headers: MEMBER_H });
  const richListed = (richList.j?.sessions || []).find((s) => s.id === richRec?.id);
  ok("t39 member GET exposes rich cookies for open", richListed?.cookies?.[0]?.domain === ".primevideo.com" && richListed?.sessionId === "t39-probe-session");

  const richRm = await jfetch(`/api/live-sessions?id=${richRec?.id}`, { method: "DELETE", headers: ADMIN_H });
  const legacyRm = await jfetch(`/api/live-sessions?id=${legacyRec?.id}`, { method: "DELETE", headers: ADMIN_H });
  ok("t39 cleanup rich+legacy entries", richRm.res.ok && legacyRm.res.ok);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
