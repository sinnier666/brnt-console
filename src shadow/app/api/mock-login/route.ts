import { NextRequest, NextResponse } from "next/server";

// Demo target for LoginProbe.
// alice / wonderland  →  mock_session=valid-alice
// bob / test1234      →  mock_session=valid-bob
// GET without a valid session → login form (with csrf_token hidden field)
// GET with a valid session    → "Welcome back, <name>!" dashboard
// GET ?logout=1               → clears the session cookie

const COOKIE = "mock_session";
const MAX_AGE = 600; // 10 minutes

const USERS: Record<string, { pass: string; name: string }> = {
  alice: { pass: "wonderland", name: "alice" },
  bob: { pass: "test1234", name: "bob" },
};

function formHtml(error = ""): string {
  return `<!DOCTYPE html>
<html>
<head><title>Acme Portal — Sign in</title></head>
<body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px">
  <h1>Acme Portal</h1>
  ${error ? `<p style="color:#b91c1c">Login failed: incorrect username or password. Please try again.</p>` : ""}
  <form method="POST" action="/api/mock-login">
    <input type="hidden" name="csrf_token" value="${Math.random().toString(36).slice(2)}" />
    <p><label>Username <input type="text" name="username" /></label></p>
    <p><label>Password <input type="password" name="password" /></label></p>
    <p><button type="submit" name="submit" value="Log in">Log in</button></p>
  </form>
  <footer>Acme Portal © 2026 — demo target for LoginProbe</footer>
</body>
</html>`;
}

function dashboardHtml(name: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>Acme Portal — Dashboard</title></head>
<body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:0 16px">
  <h1>Welcome back, ${name}!</h1>
  <p>Login successful. This is your dashboard.</p>
  <nav><a href="/api/mock-login?logout=1">Log out</a></nav>
  <footer>Acme Portal © 2026 — demo target for LoginProbe</footer>
</body>
</html>`;
}

function readCookie(req: NextRequest): string | null {
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(new RegExp(`${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function validUser(val: string | null): string | null {
  if (!val) return null;
  const m = val.match(/^valid-([a-z]+)$/);
  if (!m) return null;
  const name = m[1];
  return USERS[name] ? name : null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);

  if (url.searchParams.get("logout") != null) {
    const res = NextResponse.redirect(new URL("/api/mock-login", url.origin), { status: 303 });
    res.headers.append(
      "set-cookie",
      `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=lax`
    );
    return res;
  }

  const name = validUser(readCookie(req));
  if (name) {
    return new NextResponse(dashboardHtml(name), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new NextResponse(formHtml(), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  let username = "";
  let password = "";
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      const j = await req.json();
      username = String(j.username || "");
      password = String(j.password || "");
    } catch {
      /* ignore */
    }
  } else {
    const text = await req.text();
    const params = new URLSearchParams(text);
    username = params.get("username") || "";
    password = params.get("password") || "";
  }

  const user = USERS[username.trim().toLowerCase()];
  if (user && user.pass === password) {
    const res = NextResponse.redirect(new URL("/api/mock-login", url.origin), { status: 303 });
    res.headers.append(
      "set-cookie",
      `${COOKIE}=valid-${user.name}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=lax`
    );
    return res;
  }
  return new NextResponse(formHtml("bad creds"), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
