"use client";

import { createContext, useContext, type ReactNode } from "react";

// The chat thread whose workspace resolves relative file references. Message
// bubbles provide it so deep children (tool results, reference lists) can open
// local files without threading the id through every layer.
const ThreadScopeContext = createContext<string | null>(null);

export function ThreadScope({ threadId, children }: { threadId?: string | null; children: ReactNode }) {
  return <ThreadScopeContext.Provider value={threadId ?? null}>{children}</ThreadScopeContext.Provider>;
}

export function useThreadScope(): string | null {
  return useContext(ThreadScopeContext);
}
