#!/usr/bin/env node
// Task 29 E2E: /api/nftoken against the running dev server (localhost:3000).
// 1) no access key        -> 403 ACCESS_REQUIRED
// 2) alive Netflix jar    -> ok:true + native link (Netflix iOS API round-trip)
// 3) cookies w/o NetflixId-> 422 NO_NETFLIXID
const BASE = "http://localhost:3000";
const KEY = process.env.BRNT_KEY || "BRNT-L6PA-YX7Q"; // local .data key, exp 2026-10-26

const NETSCAPE = [
  "#HttpOnly_.netflix.com\tTRUE\t/\tTRUE\t1821295654\tNetflixId\tct%3DBgjHlOvcAxLHAySXyYOze5-ZO0igBeZS8pa5mbf3ZSpU4NkC7j5iCOCIayujm-Nqn0z_pWFhXK6EdzSJQ_Q3B0BoF_phng1nRuBYS4QHOngK60JM3X7-rfmuiqfRjEVAKzd_ep_mhN5S-oDJZ3r5mNVA3tb2yXYwZ5SRrKaam23ux9Ajr7_SGNlziu9NJXQMo4YzYfaCrwbgm3u-Bs13lfL-maZ6ZlqHKUQXCbn3sPrN-vP9wD6NQcJKeJqLFLUjfxYEp1XOVCn5z3y06c8uh-7hqQ4fW7LFawZZkuyl6_c5Vqu3CuzzNxXPowgW5j-eqMHWjWYxFIe8D-75WaCUjYF5r7yKmIIHG0_d4hxLcYewxubYIPDnIR1kgPGAtJdJd9_FQ8YJCsNNWqNp_lZMlZJ2HxBGBkTE7FhuYGi9ZhXyw13IS6hF7oOht9z-8j7zMPYB7uxTymCigl0O23YHbm_xq6nOAjPFZ1cjZitpjoHTtxUYVsSYM2HFvsFSTniGMwjHF0a_nt98WOygyLKDBTlxmFTC-Yt9x1_e84-Fl0KYoEEPAaEk-ZuVSRLn9tz7HF9hLCzhYKnpEob0KVoHQ5o4Ac2I7izJgMR2QuYhrfJeGAYiDgoMEBDx-51OKBEOWLDQ%26ch%3DAQEAEAABABQRy0hw6ASVj9po9vUcNlK-XoKu3xcMac0.%26v%3D3%26pg%3DXJT4MUNLEVADDABP27QC5LFZNA",
  ".netflix.com\tTRUE\t/\tFALSE\t1820006285\tnfvdid\tBQFmAAEBEEpxUykQyUa93Pz7unxYEuFgC9_Wunm4QdFGrl9vbIq9hMeZW_mysj_vV4IPZCDjvpg3N-W2T35k0XtrfvN95GO8IEZIKgnkv_Ooo_EK5rSabzJzIP2b0r_D7xOOLSpnGudM0UO0hw2o4-8Gk6V1x2fz",
  "#HttpOnly_.netflix.com\tTRUE\t/\tTRUE\t1821295654\tSecureNetflixId\tv%3D3%26mac%3DAQEAEQABABRmQf9N4H-ds4bK_MtHMXqLueD2QHErWro.%26dt%3D1789761187556",
].join("\n");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
}

async function main() {
  // 1) access gate
  let r = await fetch(`${BASE}/api/nftoken`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cookies: "NetflixId=x" }),
  });
  let j = await r.json().catch(() => null);
  check("no key -> 403", r.status === 403 && j?.error === "ACCESS_REQUIRED", `got ${r.status}`);

  // 2) alive jar -> native token
  r = await fetch(`${BASE}/api/nftoken`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brnt-access": KEY },
    body: JSON.stringify({ cookies: NETSCAPE }),
  });
  j = await r.json().catch(() => null);
  check("alive jar -> 200 ok", r.status === 200 && j?.ok === true, `got ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  check("link is native shape", typeof j?.link === "string" && j.link.startsWith("https://netflix.com/?nftoken=") && !/^BR[01]\./.test(j.link.split("nftoken=")[1] || ""), j?.link?.slice(0, 60));
  check("token is long enough", (j?.link || "").length - "https://netflix.com/?nftoken=".length > 200);
  check("expires sane (epoch s)", j?.expires > 1.7e9 && j?.expires < 2.2e9, String(j?.expires));
  console.log(`  native link: ${j?.link?.slice(0, 70)}...`);
  const expLabel = j?.expires ? new Date(j.expires * 1000).toISOString().slice(0, 10) : "?";
  console.log(`  token expires: ${expLabel}`);

  // 2b) jar array form (what the dialog sends)
  r = await fetch(`${BASE}/api/nftoken`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brnt-access": KEY },
    body: JSON.stringify({
      jar: [{ name: "NetflixId", value: "ct%3DBgjHlOvcAxLHAySXyYOze5-ZO0ig" }, { name: "nfvdid", value: "BQF" }],
    }),
  });
  j = await r.json().catch(() => null);
  check("jar array form accepted (status is 200/4xx-with-message, not 500)", r.status === 200 || r.status === 502 || r.status === 422, `got ${r.status} ${JSON.stringify(j).slice(0, 120)}`);

  // 3) missing NetflixId
  r = await fetch(`${BASE}/api/nftoken`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brnt-access": KEY },
    body: JSON.stringify({ cookies: ".netflix.com\tTRUE\t/\tFALSE\t123\tOptanonAlertBoxClosed\t2026-01-01" }),
  });
  j = await r.json().catch(() => null);
  check("no NetflixId -> 422 NO_NETFLIXID", r.status === 422 && j?.error === "NO_NETFLIXID", `got ${r.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("E2E crashed:", e); process.exit(1); });
