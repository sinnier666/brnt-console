// Direct unit check: does setFromResponse preserve HttpOnly after the fix?
import { CookieJar } from "../src/lib/cookies.ts";

const jar = new CookieJar();
jar.setFromResponse("http://localhost:3000/api/mock-login", [
  "mock_session=valid-alice; Path=/; Max-Age=600; HttpOnly; SameSite=lax",
]);
const all = jar.all();
console.log(JSON.stringify(all, null, 2));
if (all[0]?.httpOnly !== true) {
  console.error("FAIL: httpOnly not preserved");
  process.exit(1);
}
console.log("OK: httpOnly preserved by setFromResponse");
