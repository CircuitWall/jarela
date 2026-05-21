// Ephemeral state store for in-app OAuth flows (Gmail, Microsoft, ...).
//
// Why this exists: the user types client_id + client_secret in the
// Integrations panel, we POST to /oauth/start, stash them here keyed by a
// random `state`, and return the provider's authorize URL. The browser
// bounces back to /oauth/callback with `?code&state`, we exchange, and
// persist the integration. Meanwhile the panel polls /oauth/status.
//
// Pinned to globalThis so HMR in dev doesn't lose pending flows.
//
// Same shape used by both gmail-oauth.ts and microsoft-oauth.ts — pass a
// unique `globalKey` per provider so they don't share a Map.

import { randomBytes } from "crypto";
import { getOrCreateGlobal } from "@/lib/utils/global-state";

export interface OAuthFlow {
  createdAt: number;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  status: "pending" | "done" | "error";
  error?: string;
}

export interface OAuthFlowStore {
  create(input: { clientId: string; clientSecret: string; redirectUri: string }): {
    state: string;
    flow: OAuthFlow;
  };
  get(state: string): OAuthFlow | undefined;
  update(state: string, patch: Partial<OAuthFlow>): void;
  delete(state: string): void;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_FLOWS = 32;

export function createOAuthFlowStore(opts: {
  globalKey: string;
  ttlMs?: number;
  maxFlows?: number;
}): OAuthFlowStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxFlows = opts.maxFlows ?? DEFAULT_MAX_FLOWS;
  const flows = getOrCreateGlobal<Map<string, OAuthFlow>>(opts.globalKey, () => new Map());

  function gc(): void {
    const now = Date.now();
    for (const [k, v] of flows) {
      if (now - v.createdAt > ttlMs) flows.delete(k);
    }
    // Hard cap so a stuck UI can't grow this unbounded.
    if (flows.size > maxFlows) {
      const oldest = [...flows.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (let i = 0; i < oldest.length - maxFlows; i++) flows.delete(oldest[i][0]);
    }
  }

  return {
    create(input) {
      gc();
      const state = randomBytes(16).toString("hex");
      const flow: OAuthFlow = { createdAt: Date.now(), status: "pending", ...input };
      flows.set(state, flow);
      return { state, flow };
    },
    get(state) {
      gc();
      return flows.get(state);
    },
    update(state, patch) {
      const f = flows.get(state);
      if (f) Object.assign(f, patch);
    },
    delete(state) {
      flows.delete(state);
    },
  };
}
