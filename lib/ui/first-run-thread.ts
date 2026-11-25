"use client";

import { useEffect, useState } from "react";
import { readBrowserValue, writeBrowserValue } from "@/lib/ui/browser-store";

const FIRST_RUN_THREAD_KEY_PREFIX = "jarela:first-run-thread:";

export function rememberFirstRunThread(threadId: string): void {
  writeBrowserValue(FIRST_RUN_THREAD_KEY_PREFIX + threadId, "1");
}

export function isMarkedFirstRunThread(threadId: string | null): boolean {
  if (!threadId) return false;
  return readBrowserValue(FIRST_RUN_THREAD_KEY_PREFIX + threadId) === "1";
}

export function useIsFirstRunThread(threadId: string | null): boolean {
  const [marked, setMarked] = useState(() => isMarkedFirstRunThread(threadId));

  useEffect(() => {
    setMarked(isMarkedFirstRunThread(threadId));
  }, [threadId]);

  return marked;
}