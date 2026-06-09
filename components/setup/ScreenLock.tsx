"use client";

import { PinKeypad } from "./PinKeypad";

// Screen-lock overlay (presence check). Mounted by AppShell when the
// idle timer fires or the server returns 423 `screen-locked`. Does
// NOT touch the in-memory master key — background work (agents,
// scheduler, bridges) keeps running underneath. The /verify-pin
// endpoint just confirms the human at the keyboard and clears the
// idle flag.

export function ScreenLock({ onUnlock }: { onUnlock: () => void }) {
  return <PinKeypad mode="unlock" onSuccess={onUnlock} />;
}
