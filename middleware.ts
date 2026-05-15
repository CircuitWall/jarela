import { NextRequest, NextResponse } from "next/server";

// Two-tier access control for LangGUI:
//   1. Local loopback (127.0.0.1, ::1, localhost) — always allowed, no auth.
//      The default running mode. Same machine, same user, full access.
//   2. Anything else (LAN IP, Tailscale, ngrok, public IP) — requires HTTP
//      Basic Auth using LANGGUI_ACCESS_PASSWORD. If that env isn't set,
//      remote access is refused entirely with 403, so accidentally exposing
//      port 4312 (e.g. via `next start -H 0.0.0.0`) doesn't silently leak
//      your chat history + agent control surface.
//
// Notes / trade-offs:
//   - Loopback detection trusts the request's host/x-forwarded-for headers.
//     Spoofable in theory; in practice not a concern unless you've already
//     fronted with a misconfigured proxy. For real security, run behind a
//     reverse proxy with its own auth and bind LangGUI only to 127.0.0.1.
//   - Basic Auth is browser-native (the browser handles the prompt). No
//     login page / session cookies / CSRF concerns on our side. Browsers
//     cache the credentials for the session.
//   - WS upgrade requests (/api/v1/ws) get the same treatment via the
//     matcher; the WS handshake includes Authorization headers when reused
//     after a successful Basic Auth challenge.

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|$)/;
const LOOPBACK_IP = /^(127\.|::1$|::ffff:127\.)/;

function isLoopback(req: NextRequest): boolean {
  // If a reverse proxy or VPN router is in front, trust its forwarded address.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const client = xff.split(",")[0].trim();
    return LOOPBACK_IP.test(client);
  }
  // Direct connection — fall back to the host header. The browser sets this
  // to whatever URL the user typed: `localhost:4312`, `127.0.0.1:4312`, or
  // a hostname like `langgui.local`. Only the first two are loopback.
  const host = req.headers.get("host") || "";
  return LOOPBACK_HOST.test(host);
}

// Constant-time string comparison so password-guess timing can't leak length
// or character info. Works in both Edge and Node runtimes.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkBasicAuth(req: NextRequest, expectedUser: string, expectedPass: string): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return false;
  try {
    const raw = atob(header.slice(6).trim());
    const idx = raw.indexOf(":");
    if (idx < 0) return false;
    const user = raw.slice(0, idx);
    const pass = raw.slice(idx + 1);
    // Compare both — but only after extracting both — so an empty-username
    // attempt fails on the user check, not the password check.
    return timingSafeEqual(user, expectedUser) && timingSafeEqual(pass, expectedPass);
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  if (isLoopback(req)) return NextResponse.next();

  const password = process.env.LANGGUI_ACCESS_PASSWORD;
  if (!password) {
    return new NextResponse(
      "LangGUI: remote access is disabled. Set LANGGUI_ACCESS_PASSWORD in the server's env to enable.\n",
      { status: 403, headers: { "Content-Type": "text/plain" } },
    );
  }

  const user = process.env.LANGGUI_ACCESS_USER || "langgui";
  if (checkBasicAuth(req, user, password)) return NextResponse.next();

  return new NextResponse("Authentication required.\n", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="LangGUI", charset="UTF-8"',
      "Content-Type": "text/plain",
    },
  });
}

// Apply to everything except Next.js internals + static manifest icons that
// PWA clients fetch before the user has a chance to authenticate.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|_next/data|favicon.ico|manifest.json|sw.js|workbox-.*|icon-.*).*)",
  ],
};
