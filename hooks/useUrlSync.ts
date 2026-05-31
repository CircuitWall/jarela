"use client";
// Bidirectional sync between AppContext (tab + selectedItem) and the URL's
// search params. Mounted once in AppShell.
//
// On mount: read window.location → dispatch SET_TAB + SET_SELECTION so a
// fresh load lands on the deep-linked surface. On reducer change: replace
// the URL via history.replaceState so reload preserves the surface.
//
// We use history.replaceState directly rather than next/navigation's
// router.replace() because the latter triggers a soft navigation that can
// re-mount route segments — we just want the address bar to mirror state
// without disturbing the <Activity>-based tab keepalive in AppShell.

import { useEffect, useRef } from "react";
import { useAppContext, type Tab } from "@/contexts/AppContext";
import { buildHref, parseHref } from "@/lib/ui/navigate";

const TABS: Tab[] = ["chat", "dashboard", "agents", "memory", "documents", "models", "mcp", "extensions", "tools", "connections", "tasks", "bridges", "profile", "harness"];

export function useUrlSync() {
  const { state, dispatch } = useAppContext();
  // Idempotency guard: avoid re-firing the initial dispatch when the URL we
  // just wrote matches the state that wrote it.
  const lastWrittenRef = useRef<string | null>(null);

  // Initial read + popstate (back/forward) listener.
  useEffect(() => {
    function applyFromUrl() {
      if (typeof window === "undefined") return;
      const href = `${window.location.search}${window.location.hash}`;
      const parsed = parseHref(href);
      const tab = parsed.tab ?? "chat";
      if (TABS.includes(tab)) {
        dispatch({ type: "SET_TAB", tab });
        dispatch({ type: "SET_SELECTION", tab, itemId: parsed.item ?? null });
      }
    }
    applyFromUrl();
    window.addEventListener("popstate", applyFromUrl);
    return () => window.removeEventListener("popstate", applyFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror reducer → URL. Preserve any existing #fragment so message anchors
  // survive tab toggles.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const item = state.selectedItem[state.activeTab] ?? null;
    const hash = window.location.hash.replace(/^#/, "") || null;
    const next = buildHref(state.activeTab, item, hash);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current === next || lastWrittenRef.current === next) return;
    lastWrittenRef.current = next;
    window.history.replaceState(null, "", next);
  }, [state.activeTab, state.selectedItem]);
}
