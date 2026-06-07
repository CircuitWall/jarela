import { NextRequest, NextResponse } from "next/server";
import { requireAccess, validateRequestOrigin } from "@/lib/auth/access";
import { isMasterKeyLocked } from "@/lib/crypto/master-key";
import {
  isScreenLocked,
  recordUserActivity,
} from "@/lib/security/screen-lock";

// API paths that must stay reachable while the master key is locked, so
// the unlock splash and its supporting probes can function. Everything
// else under /api/v1/* gets a 423 until the user unlocks (ADR-0063).
const LOCKED_ALLOWLIST = [
  "/api/v1/security/",
  "/api/v1/health",
  "/api/v1/config",
];

// API paths that count as "passive polling" rather than user activity.
// Background tabs poll these forever; if they counted as activity, the
// idle timer would never elapse and the screen would never lock.
//
// SSE event stream + health + security state probe are the main culprits.
// Anything else (GETs to /agents, /threads, plus all POSTs/PATCHes) is
// treated as user-initiated.
const ACTIVITY_IGNORE_PREFIXES = [
  "/api/v1/health",
  "/api/v1/events",
  "/api/v1/security/state",
];

function isPassivePoll(path: string): boolean {
  return ACTIVITY_IGNORE_PREFIXES.some((p) => path.startsWith(p));
}

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

  // ADR-0063 lock gate. While the master key is locked, every
  // /api/v1/* route that isn't on the unlock-time allowlist returns 423
  // (Locked) so stale clients show a clear state instead of cascading
  // 500s from MasterKeyLockedError thrown deep inside decryption.
  const path = req.nextUrl.pathname;
  if (path.startsWith("/api/v1/") && isMasterKeyLocked()) {
    const allowed = LOCKED_ALLOWLIST.some((p) => path.startsWith(p));
    if (!allowed) {
      return NextResponse.json(
        { error: "locked", message: "master key is locked; unlock via splash" },
        { status: 423 },
      );
    }
  }

  // Screen-lock gate (presence check). Distinct from master-key lock:
  // background work keeps running, only the UI is gated. If the request
  // is user-initiated (not passive polling) and the screen is locked,
  // reject with 423 + a different error code so the client knows to
  // show the verify-PIN overlay rather than the full master-key splash.
  // Allow the same security/health/config allowlist through so the
  // overlay can verify the PIN.
  if (path.startsWith("/api/v1/")) {
    if (isScreenLocked()) {
      const allowed = LOCKED_ALLOWLIST.some((p) => path.startsWith(p));
      if (!allowed) {
        return NextResponse.json(
          { error: "screen-locked", message: "idle screen lock; verify pin" },
          { status: 423 },
        );
      }
    } else if (!isPassivePoll(path)) {
      // Only update last-activity when NOT locked — a request arriving
      // while the lock is up shouldn't push the timer forward.
      recordUserActivity();
    }
  }

  return NextResponse.next();
}
