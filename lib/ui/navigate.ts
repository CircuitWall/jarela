// Parse in-app deep-link hrefs into the {tab, item, hash} shape that
// AppContext understands. Consumers (Toaster button, markdown <a> in
// MessageBubble) call this and dispatch SET_TAB + SET_SELECTION themselves;
// keeping the parser pure means it works outside React too.

import type { Tab } from "@/contexts/AppContext";

export interface ParsedHref {
  tab?: Tab;
  item?: string;
  hash?: string;
  external: boolean;
}

const TABS: Tab[] = ["chat", "agents", "memory", "models", "mcp", "extensions", "tools", "connections", "tasks", "bridges", "profile", "harness", "documents"];

export function parseHref(input: string | null | undefined): ParsedHref {
  if (!input) return { external: false };
  let href = input;

  // Absolute URL with scheme (http, https, mailto, tel, …) → external.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { external: true };

  let hash: string | undefined;
  const hashIdx = href.indexOf("#");
  if (hashIdx >= 0) {
    hash = href.slice(hashIdx + 1) || undefined;
    href = href.slice(0, hashIdx);
  }

  let queryStr = "";
  const qIdx = href.indexOf("?");
  if (qIdx >= 0) queryStr = href.slice(qIdx + 1);

  const params = new URLSearchParams(queryStr);
  const tabRaw = params.get("tab");
  const tab = TABS.includes(tabRaw as Tab) ? (tabRaw as Tab) : undefined;
  const item = params.get("item") ?? undefined;
  return { tab, item, hash, external: false };
}

// Build the URL we want to push when the reducer is the source of truth.
export function buildHref(tab: Tab, item?: string | null, hash?: string | null): string {
  const params = new URLSearchParams();
  if (tab !== "chat") params.set("tab", tab);
  if (item) params.set("item", item);
  const qs = params.toString();
  const fragment = hash ? `#${hash.replace(/^#/, "")}` : "";
  return `/${qs ? `?${qs}` : ""}${fragment}`;
}
