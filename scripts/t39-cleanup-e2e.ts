// T39 E2E cleanup: remove the live entry, the replay session file, and any
// usage-log rows the E2E created.
// Run: bun scripts/t39-cleanup-e2e.ts

import { kv } from "../src/lib/storage.ts";

const BASE = "http://localhost:3000";
const ADMIN_KEY = "brnt-admin";
const LIVE_ID = process.argv[2] || "ls_mvkzm53u_ed116f";
const SESSION_ID = process.argv[3] || "mvkzm53hykdvlsx0dpz4q5ti";

// 1. live entry
const del = await fetch(`${BASE}/api/live-sessions?id=${encodeURIComponent(LIVE_ID)}`, {
  method: "DELETE",
  headers: { "x-brnt-admin": ADMIN_KEY },
});
console.log("live entry delete:", del.status);

// 2. replay session file (match by id suffix)
const keys = await kv.list("sessions/");
const hit = keys.find((k) => k.endsWith(`-${SESSION_ID}.json`));
if (hit) {
  await kv.del(hit);
  console.log("session file removed:", hit);
} else {
  console.log("session file not found (already gone)");
}

// 3. usage logs for today (member activity from the E2E open)
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const ddel = await fetch(`${BASE}/api/usage-log?date=${today}`, {
  method: "DELETE",
  headers: { "x-brnt-admin": ADMIN_KEY },
});
const dj = await ddel.json().catch(() => null);
console.log(`usage log ${today} clear:`, ddel.status, JSON.stringify(dj));

// 4. verify empty
const list = await fetch(`${BASE}/api/live-sessions`, { headers: { "x-brnt-access": "BRNT-L6PA-YX7Q" } });
const lj = await list.json();
console.log("live store size now:", lj?.sessions?.length);
