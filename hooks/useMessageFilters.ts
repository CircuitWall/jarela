"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// ADR-0022: per-agent message-channel display filters.
//
// Canonical channel keys — single source of truth for the chat-panel
// filter toolbar. The first three correspond 1:1 to the persisted
// `messages.category` column; `tool_use` and `thinking` are pure UI
// toggles that hide already-rendered sub-content without touching
// persistence. Mirrors `DISPLAY_FILTER_KEYS` in
// `lib/stores/agent-configs.ts` — keep both lists in sync.
export const MESSAGE_FILTER_KEYS = [
  "scheduled_task",
  "bridge",
  "synthetic",
  "tool_use",
  "thinking",
] as const;
export type MessageFilterKey = (typeof MESSAGE_FILTER_KEYS)[number];

export type MessageFilters = Record<MessageFilterKey, boolean>;

const LEGACY_GLOBAL_KEY = "jarela:msg-category-filters";
const CACHE_KEY_PREFIX = "jarela:msg-filters:"; // + agentId
const MIGRATION_FLAG_KEY = "jarela:msg-filters:legacy-migrated";

const DEFAULTS: MessageFilters = {
  scheduled_task: true,
  bridge: true,
  synthetic: true,
  tool_use: true,
  thinking: true,
};

function readCache(agentId: string): MessageFilters | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY_PREFIX + agentId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MessageFilters>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return null;
  }
}

function writeCache(agentId: string, filters: MessageFilters): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY_PREFIX + agentId, JSON.stringify(filters));
  } catch {
    /* private-mode quota; in-memory state remains correct */
  }
}

function readLegacyGlobal(): Partial<MessageFilters> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LEGACY_GLOBAL_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<MessageFilters>;
  } catch {
    return null;
  }
}

/**
 * Per-agent message-channel display filters.
 *
 * Source of truth lives on `agent_configs.display_filters` (JSON column).
 * The hook fetches on mount / when `agentId` changes, caches in
 * localStorage keyed by agent id to avoid toolbar flicker on reload, and
 * writes through to `PUT /api/v1/agents/:id/display-filters` on every
 * toggle (merged server-side so multi-tab toggles don't clobber).
 *
 * If `agentId` is null/undefined (e.g. agent list still loading) the hook
 * falls back to defaults — toggling is a no-op until an id is provided.
 *
 * Legacy migration: the previous build used a single global localStorage
 * key (`jarela:msg-category-filters`). On first run we copy that value
 * into the first agent's filters, set a one-shot migration flag, and
 * remove the global key. After that the agent column is canonical.
 */
export function useMessageFilters(agentId?: string | null) {
  const [filters, setFilters] = useState<MessageFilters>(() =>
    agentId ? readCache(agentId) ?? DEFAULTS : DEFAULTS,
  );
  // Guard against late-arriving GET responses overwriting a more-recent
  // user toggle. We bump this on every toggle; stale fetches are dropped.
  const seqRef = useRef(0);

  // Sync from server when the agent changes.
  useEffect(() => {
    if (!agentId) {
      // Agent switched to none — reset to defaults. setState in effect is
      // intentional here: agentId is the external key driving this state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFilters(DEFAULTS);
      return;
    }
    const cached = readCache(agentId);
    if (cached) setFilters(cached);
    else setFilters(DEFAULTS);

    const mySeq = ++seqRef.current;
    let cancelled = false;

    (async () => {
      try {
        // One-shot legacy migration: if we still have the old global key
        // AND we haven't migrated yet, push it onto THIS agent (the user
        // is interacting with it now, so it's the most reasonable owner)
        // and clear both the global key and the flag's reverse case.
        const legacy =
          typeof window !== "undefined" &&
          !window.localStorage.getItem(MIGRATION_FLAG_KEY)
            ? readLegacyGlobal()
            : null;

        if (legacy) {
          await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/display-filters`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ filters: legacy }),
          }).catch(() => {});
          try {
            window.localStorage.setItem(MIGRATION_FLAG_KEY, "1");
            window.localStorage.removeItem(LEGACY_GLOBAL_KEY);
          } catch {}
        }

        const res = await fetch(
          `/api/v1/agents/${encodeURIComponent(agentId)}/display-filters`,
          { method: "GET" },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { filters: Partial<MessageFilters> };
        if (cancelled || mySeq !== seqRef.current) return;
        const merged = { ...DEFAULTS, ...body.filters };
        setFilters(merged);
        writeCache(agentId, merged);
      } catch {
        /* offline / first-launch race — defaults are fine */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const toggle = useCallback(
    (key: MessageFilterKey) => {
      setFilters((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        if (agentId) {
          writeCache(agentId, next);
          seqRef.current++;
          // Fire-and-forget; cache + state already reflect the new value.
          // If the request fails we keep the optimistic state — next page
          // load will reconcile from the server.
          void fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/display-filters`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ filters: { [key]: next[key] } }),
          }).catch(() => {});
        }
        return next;
      });
    },
    [agentId],
  );

  const reset = useCallback(() => {
    if (!agentId) {
      setFilters(DEFAULTS);
      return;
    }
    setFilters(DEFAULTS);
    writeCache(agentId, DEFAULTS);
    seqRef.current++;
    void fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/display-filters`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filters: null }),
    }).catch(() => {});
  }, [agentId]);

  return { filters, toggle, reset };
}
