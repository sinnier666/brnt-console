#!/usr/bin/env node
// Task 35 — access hardening: the admin key must NEVER work as a member key,
// admin-verify gates admin UI, minting keeps working.

const BASE = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_KEY = "brnt-admin";

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

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let j = null;
  try {
    j = await res.json();
  } catch {}
  return { res, j };
}

async function main() {
  // 1) admin key rejected as member key — every casing/spacing
  for (const code of ["brnt-admin", "BRNT-ADMIN", "  brnt-admin  ", "Brnt-Admin"]) {
    const { res } = await post("/api/access", { action: "validate", code });
    ok(`validate("${code}") rejected`, res.status === 403, `status=${res.status}`);
  }

  // 2) member gate endpoints reject the admin key as x-brnt-access
  const h = { "x-brnt-access": "brnt-admin" };
  const a = await post("/api/check-login", { url: "https://example.com" }, h);
  ok("check-login rejects admin key as member key", a.res.status === 403, `status=${a.res.status}`);
  const b = await post("/api/nftoken", {}, h);
  ok("nftoken rejects admin key as member key", b.res.status === 403, `status=${b.res.status}`);
  const c = await fetch(`${BASE}/api/live-sessions`, { headers: { "x-brnt-access": "brnt-admin" } });
  ok("live-sessions rejects admin key as member key", c.status === 403, `status=${c.status}`);
  const d = await fetch(`${BASE}/api/usage-log?mine=1`, { headers: { "x-brnt-access": "brnt-admin" } });
  ok("usage-log rejects admin key as member key", d.status === 403, `status=${d.status}`);

  // 3) admin-verify
  const bad = await post("/api/access", { action: "admin-verify", adminKey: "wrong-key" });
  ok("admin-verify wrong key -> 403", bad.res.status === 403);
  const good = await post("/api/access", { action: "admin-verify", adminKey: ADMIN_KEY });
  ok("admin-verify correct key -> ok", good.res.ok && good.j?.admin === true, JSON.stringify(good.j));

  // 4) minting still works and the minted key validates (any casing)
  const mint = await post("/api/access", { action: "generate", adminKey: ADMIN_KEY, days: 1, note: "t35 hardening" });
  ok("mint with admin key works", mint.res.ok && mint.j?.ok && /^BRNT-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(mint.j?.record?.code || ""), JSON.stringify(mint.j));
  const code = mint.j?.record?.code || "";
  const v1 = await post("/api/access", { action: "validate", code });
  ok("minted key validates", v1.res.ok && v1.j?.record?.code === code);
  const v2 = await post("/api/access", { action: "validate", code: code.toLowerCase() });
  ok("minted key validates case-insensitively", v2.res.ok);
  const e = await fetch(`${BASE}/api/live-sessions`, { headers: { "x-brnt-access": code } });
  ok("minted key works on live-sessions GET", e.status === 200, `status=${e.status}`);

  // 5) member cannot use admin-only endpoints
  const f = await fetch(`${BASE}/api/live-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brnt-access": code },
    body: JSON.stringify({ cookies: "a=b" }),
  });
  ok("member cannot add live sessions", f.status === 403, `status=${f.status}`);
  const g = await fetch(`${BASE}/api/usage-log?list=1`, { headers: { "x-brnt-access": code } });
  ok("member cannot list usage dates", g.status === 403, `status=${g.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
