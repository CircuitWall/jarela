"use client";

// Non-removable upstream attribution.
//
// Rebranded overlays can replace the app name, description, logo, icons, and
// accent color (see lib/env/app-config.ts), but this credit line is
// deliberately hardcoded — UPSTREAM_NAME / UPSTREAM_URL are constants, not
// env-backed getters. It renders once, subtly, next to the version tag on
// the boot screen.
//
// This is distinct from `getAppIssueUrl()`, which IS overridable and points
// at the *fork's* bug tracker.

import { UPSTREAM_NAME, UPSTREAM_URL, getAppName } from "@/lib/env/app-config";

export function PoweredBy({ className = "" }: { className?: string }) {
  // Upstream builds already say "Jarela" everywhere; a "Powered by Jarela"
  // line under the Jarela wordmark would just be noise. Only overlays that
  // actually renamed the app get the credit line.
  if (getAppName() === UPSTREAM_NAME) return null;

  return (
    <a
      href={UPSTREAM_URL}
      target="_blank"
      rel="noreferrer noopener"
      className={`text-[11px] text-fg-faint/70 hover:text-fg-subtle transition-colors ${className}`}
    >
      Powered by {UPSTREAM_NAME}
    </a>
  );
}
