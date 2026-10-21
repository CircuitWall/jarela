"use client";

import { useEffect, useState } from "react";

const FIRST_RUN_THREAD_KEY_PREFIX = "jarela:first-run-thread:";

export function rememberFirstRunThread(threadId: string): void {
  try {
    window.localStorage.setItem(FIRST_RUN_THREAD_KEY_PREFIX + threadId, "1");
  } catch {
    // Private browsing may block storage; the kickoff row itself stays hidden.
  }
}

export function isMarkedFirstRunThread(threadId: string | null): boolean {
  if (!threadId) return false;
  try {
    return window.localStorage.getItem(FIRST_RUN_THREAD_KEY_PREFIX + threadId) === "1";
  } catch {
    return false;
  }
}

export function useIsFirstRunThread(threadId: string | null): boolean {
  const [marked, setMarked] = useState(() => isMarkedFirstRunThread(threadId));

  useEffect(() => {
    setMarked(isMarkedFirstRunThread(threadId));
  }, [threadId]);

  return marked;
}