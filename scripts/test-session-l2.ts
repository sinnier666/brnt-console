// Proves the KV L2 hydrate path in a FRESH process (empty in-memory L1):
// bun run scripts/test-session-l2.ts  ->  must load the session purely from .data/sessions/.
import { getSession } from "../src/lib/session-store";

const id = process.argv[2];
if (!id) {
  console.error("usage: bun run scripts/test-session-l2.ts <sessionId>");
  process.exit(2);
}

const s = await getSession(id);
if (!s) {
  console.log("FAIL: session not found from L2");
  process.exit(1);
}
const cookies = s.jar.all().map((c) => `${c.name}=${c.value}`);
console.log("L2 HYDRATE ✓ id:", s.id);
console.log("  target:", s.target);
console.log("  createdAt:", new Date(s.createdAt).toISOString());
console.log("  cookies:", cookies.join(" "));
if (!cookies.some((c) => c.startsWith("mock_session="))) {
  console.log("FAIL: expected mock_session cookie in the hydrated jar");
  process.exit(1);
}
