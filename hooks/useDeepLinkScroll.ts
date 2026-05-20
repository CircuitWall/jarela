"use client";
// Shared scroll-to + highlight effect for settings panels. Each panel renders
// its rows with stable DOM ids (e.g. id="integration-gmail"); this hook reads
// state.selectedItem[tab] and, when it changes, scrolls that row into view
// and adds a one-shot highlight ring.
//
// We use querySelector inside the panel's container ref to avoid colliding
// with id collisions across panels (a memory key shouldn't match an mcp
// server name even if the strings overlap).

import { useEffect, useRef, type RefObject } from "react";
import { useAppContext, type Tab } from "@/contexts/AppContext";

const HIGHLIGHT_CLASS = "jarela-deep-link-flash";
const HIGHLIGHT_MS = 1600;

export function useDeepLinkScroll(tab: Tab, idPrefix: string, containerRef: RefObject<HTMLElement | null>) {
  const { state } = useAppContext();
  const item = state.selectedItem[tab];
  const lastSeenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!item) {
      lastSeenRef.current = null;
      return;
    }
    if (lastSeenRef.current === item) return;
    const root = containerRef.current ?? document;
    // Defer one frame so freshly-rendered rows exist in the DOM.
    const raf = requestAnimationFrame(() => {
      const safe = item.replace(/"/g, '\\"');
      const el = root.querySelector(`[data-deep-link-id="${safe}"]`) as HTMLElement | null;
      if (!el) return;
      lastSeenRef.current = item;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add(HIGHLIGHT_CLASS);
      setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
    });
    return () => cancelAnimationFrame(raf);
    // idPrefix is stable; we don't depend on it for re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, tab]);
}
