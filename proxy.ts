import { NextRequest, NextResponse } from "next/server";
import { requireAccess, validateRequestOrigin } from "@/lib/auth/access";

// Tailscale identity passthrough.
//   - Local loopback (Host = localhost / 127.0.0.1 / [::1]) → allowed, no auth.
//     The host machine's user is the admin; manages the whitelist via the
//     Profile panel.
//   - Anything else → must carry a `Tailscale-User-Login` header (set by the
//     local tailscaled when proxied through `tailscale serve`) AND that
//     identity must be on the whitelist. Anything else → 403.
//
// Recommended deployment: bind to 127.0.0.1 (the Next.js default) and put
// `tailscale serve` in front. Any non-loopback bind makes the Host header
// spoofable from the LAN — see ADR-0007.
//
// Runs on Node runtime so we can read the SQLite-backed whitelist.
// Note: this file was previously `middleware.ts`. Next 16 renamed the
// convention to `proxy` (the file-level export is `proxy(req)`) and the
// proxy always runs on the Node runtime, so the `runtime` config option
// is no longer allowed (and not needed).

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|_next/data|favicon.ico|manifest.json|sw.js|workbox-.*|icon-.*).*)",
  ],
};

export function proxy(req: NextRequest) {
  const result = requireAccess({
    headers: req.headers,
    host: req.headers.get("host"),
  });

  if (!result.allowed) {
    if (result.reason === "no-identity") {
      return new NextResponse(
        "Jarela: remote access requires Tailscale identity passthrough. " +
          "Run the host behind `tailscale serve` and add your identity to the whitelist " +
          "from the Jarela Profile panel (open it on the host machine via http://localhost:4312).\n",
        { status: 403, headers: { "Content-Type": "text/plain" } },
      );
    }
    // not-whitelisted
    return new NextResponse(
      `Jarela: identity "${result.identity}" is not on the access list. ` +
        `Ask the host machine's local user to add it from the Profile panel.\n`,
      { status: 403, headers: { "Content-Type": "text/plain" } },
    );
  }

  // Browser-extension endpoints carve out of the origin check: extension
  // requests originate from `chrome-extension://<id>`, which never matches
  // Host. The loopback Host gate above remains the security boundary.
  if (
    req.nextUrl.pathname.startsWith("/api/v1/page-capture") ||
    req.nextUrl.pathname.startsWith("/api/v1/extension/")
  ) {
    return NextResponse.next();
  }

  // CSRF / DNS-rebinding guard for state-changing requests.
  const origin = validateRequestOrigin({
    method: req.method,
    headers: req.headers,
    host: req.headers.get("host"),
  });
  if (!origin.allowed) {
    return new NextResponse(
      `Jarela: cross-origin request rejected (${origin.reason}).\n`,
      { status: 403, headers: { "Content-Type": "text/plain" } },
    );
  }

  return NextResponse.next();
}
