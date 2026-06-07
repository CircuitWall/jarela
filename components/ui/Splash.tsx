"use client";

import { Logo } from "@/components/ui/Logo";

// Full-viewport splash shown while AppShell's first-paint data is still
// resolving (agents list, models, session). Hides the brief "empty chrome
// + spinners" flash the user would otherwise see on cold start.
//
// Kept intentionally minimal: brand mark + a small pulsing "loading" line.
export function Splash({ visible }: { visible: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
      className={[
        "fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4",
        "bg-surface text-fg",
        "transition-opacity duration-300 ease-out",
        visible ? "opacity-100" : "opacity-0 pointer-events-none",
      ].join(" ")}
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <Logo className="h-16 w-auto" />
      <p className="text-[11px] uppercase tracking-[0.3em] text-fg-faint animate-pulse">
        loading
      </p>
    </div>
  );
}
