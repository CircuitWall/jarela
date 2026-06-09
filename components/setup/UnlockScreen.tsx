"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { PinKeypad } from "./PinKeypad";

// Decrypt splash for ADR-0063 PIN-wrapped keyfiles. Two mount sites:
//
//   - app/page.tsx — when the server detects the master key is locked
//     at boot. No `onUnlock` prop, so we fall back to router.refresh()
//     to re-run the server component without a hard reload; this gives
//     a far smoother decrypt → AppShell handoff than location.reload().
//
//   - AppShell — when the master key gets re-locked mid-session and the
//     API client dispatches `jarela:master-key-locked`. The shell wants
//     to hide the overlay and drop the user on the agent picker without
//     re-running the SSR boundary, so it passes `onUnlock`.

interface Props {
  onUnlock?: () => void;
}

export function UnlockScreen({ onUnlock }: Props = {}) {
  const router = useRouter();
  const onSuccess = useCallback(() => {
    if (onUnlock) onUnlock();
    else router.refresh();
  }, [onUnlock, router]);
  return <PinKeypad mode="decrypt" onSuccess={onSuccess} />;
}
