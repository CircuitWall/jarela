import type {
  AgentConfig,
  AgentConfigIn,
  AgentInfo,
  Bridge,
  BridgeChatsResponse,
  BridgeIn,
  BridgeLiveStatus,
  BridgePatch,
  BridgeRoute,
  BridgeRouteIn,
  BridgeRoutePatch,
  ContentPart,
  EnvSyncResult,
  ExtensionsListResponse,
  IntegrationsListResponse,
  IntegrationStatus,
  McpRegistryEntry,
  McpServer,
  McpServerIn,
  PendingAction,
  ScheduledTask,
  MemoryItem,
  ModelConfig,
  ModelConfigIn,
  StreamOptions,
  ToolInfo,
  ToolPolicy,
  TaskAssignment,
  ThreadDetail,
  ThreadSummary,
  UserProfile,
} from "./types";

const BASE = "/api/v1";

const AGENT_LIST_TTL_MS = 30_000;

let agentListCache: { data: AgentConfig[] | null; fetchedAt: number; inflight: Promise<AgentConfig[]> | null } = {
  data: null,
  fetchedAt: 0,
  inflight: null,
};

function cloneAgents(rows: AgentConfig[]): AgentConfig[] {
  return rows.map((row) => ({ ...row }));
}

function setAgentListCache(rows: AgentConfig[], notify = true): AgentConfig[] {
  const snap = cloneAgents(rows);
  agentListCache = { data: snap, fetchedAt: Date.now(), inflight: null };
  if (notify && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("jarela:agents-changed"));
  }
  return cloneAgents(snap);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  agents: {
    list: (opts?: { force?: boolean }) => {
      const force = opts?.force === true;
      const now = Date.now();
      if (!force && agentListCache.data && now - agentListCache.fetchedAt < AGENT_LIST_TTL_MS) {
        return Promise.resolve(cloneAgents(agentListCache.data));
      }
      if (!force && agentListCache.inflight) return agentListCache.inflight;
      const req = request<AgentConfig[]>("/agents").then((rows) => setAgentListCache(rows, false));
      agentListCache = { ...agentListCache, inflight: req };
      return req;
    },
    get: (id: string) => request<AgentConfig>(`/agents/${encodeURIComponent(id)}`),
    create: async (data: AgentConfigIn) => {
      const created = await request<AgentConfig>("/agents", { method: "POST", body: JSON.stringify(data) });
      if (agentListCache.data) setAgentListCache([...agentListCache.data, created]);
      else if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:agents-changed"));
      return created;
    },
    update: async (id: string, data: AgentConfigIn) => {
      const updated = await request<AgentConfig>(`/agents/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(data) });
      if (agentListCache.data) setAgentListCache(agentListCache.data.map((a) => (a.id === id ? updated : a)));
      else if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:agents-changed"));
      return updated;
    },
    delete: async (id: string) => {
      const res = await request<{ deleted: boolean }>(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.deleted) {
        if (agentListCache.data) setAgentListCache(agentListCache.data.filter((a) => a.id !== id));
        else if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:agents-changed"));
      }
      return res;
    },
    getThread: (id: string) =>
      request<ThreadSummary>(`/agents/${encodeURIComponent(id)}/thread`),
    compact: (id: string) =>
      request<{ compacted: boolean; summary?: string; reason?: string; message_count?: number; context_chars?: number }>(
        `/agents/${encodeURIComponent(id)}/compact`,
        { method: "POST", body: "{}" },
      ),
  },

  tools: {
    list: () => request<ToolInfo[]>("/tools"),
  },

  extensions: {
    list: () => request<ExtensionsListResponse>("/extensions"),
  },

  threads: {
    list: (limit = 50, offset = 0) => request<ThreadSummary[]>(`/threads?limit=${limit}&offset=${offset}`),
    create: (agent_id: string, title?: string) =>
      request<ThreadSummary>("/threads", { method: "POST", body: JSON.stringify({ agent_id, title }) }),
    get: (thread_id: string, opts?: { limit?: number; before?: string; after?: string }) => {
      const p = new URLSearchParams();
      if (opts?.limit) p.set("limit", String(opts.limit));
      if (opts?.before) p.set("before", opts.before);
      // `after`: only return messages newer than this ISO timestamp. Used
      // by ChatView post-run to fetch the freshly-persisted user+assistant
      // pair instead of re-pulling the whole most-recent page.
      if (opts?.after) p.set("after", opts.after);
      const qs = p.toString() ? `?${p}` : "";
      return request<ThreadDetail>(`/threads/${thread_id}${qs}`);
    },
    delete: (thread_id: string) =>
      request<{ deleted: boolean }>(`/threads/${thread_id}`, { method: "DELETE" }),
    // Abort the active agent run on this thread. The server's stream loop
    // catches the resulting AbortError and emits an `error` + `done` so
    // any UI queue-drain hook (e.g. ChatView) still fires.
    abortRun: (thread_id: string) =>
      request<{ aborted: boolean }>(`/threads/${thread_id}/run`, { method: "DELETE" }),
  },

  memory: {
    list: (namespace?: string, search?: string, limit = 50) => {
      const p = new URLSearchParams();
      if (namespace) p.set("namespace", namespace);
      if (search) p.set("search", search);
      p.set("limit", String(limit));
      return request<MemoryItem[]>(`/memory?${p}`);
    },
    create: (namespace: string, key: string, value: unknown) =>
      request<MemoryItem>("/memory", { method: "POST", body: JSON.stringify({ namespace, key, value }) }),
    update: (namespace: string, key: string, value: unknown) =>
      request<MemoryItem>(`/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
        method: "PUT", body: JSON.stringify({ value }),
      }),
    delete: (namespace: string, key: string) =>
      request<{ deleted: boolean }>(`/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, { method: "DELETE" }),
  },

  models: {
    list: () => request<ModelConfig[]>("/models"),
    providers: () => request<string[]>("/providers"),
    catalog: (provider: string) => request<import("./types").CatalogModel[]>(`/providers/${encodeURIComponent(provider)}/models`),
    create: (name: string, data: ModelConfigIn) =>
      request<ModelConfig>("/models", { method: "POST", body: JSON.stringify({ name, ...data }) }),
    update: (name: string, data: ModelConfigIn) =>
      request<ModelConfig>(`/models/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (name: string) =>
      request<{ deleted: boolean }>(`/models/${encodeURIComponent(name)}`, { method: "DELETE" }),
  },

  profile: {
    get: () => request<UserProfile>("/profile"),
    update: (data: Partial<Pick<UserProfile, "name" | "icon" | "about">>) =>
      request<UserProfile>("/profile", { method: "PUT", body: JSON.stringify(data) }),
    setLocationConsent: (consent: boolean) =>
      request<UserProfile>("/profile/location", { method: "PUT", body: JSON.stringify({ consent }) }),
    updateLocation: (data: { lat: number; lng: number; accuracy_m?: number | null; label?: string | null }) =>
      request<UserProfile>("/profile/location", { method: "POST", body: JSON.stringify(data) }),
    clearLocation: () =>
      request<UserProfile>("/profile/location", { method: "DELETE" }),
  },

  access: {
    list: () => request<import("./types").AccessWhitelistEntry[]>("/access"),
    add: (identity: string, display_name?: string | null) =>
      request<import("./types").AccessWhitelistEntry>("/access", {
        method: "POST", body: JSON.stringify({ identity, display_name }),
      }),
    remove: (identity: string) =>
      request<{ deleted: boolean }>(`/access/${encodeURIComponent(identity)}`, { method: "DELETE" }),
  },

  tasks: {
    list: () => request<TaskAssignment[]>("/tasks"),
    assign: (agent_id: string, model_config_name: string, tool_policy?: ToolPolicy) =>
      request<TaskAssignment>(`/tasks/${encodeURIComponent(agent_id)}`, {
        method: "PUT", body: JSON.stringify({ model_config_name, tool_policy }),
      }),
    unassign: (agent_id: string) =>
      request<{ deleted: boolean }>(`/tasks/${encodeURIComponent(agent_id)}`, { method: "DELETE" }),
  },

  mcp: {
    list: () => request<McpServer[]>("/mcp-servers"),
    create: (data: McpServerIn) =>
      request<McpServer>("/mcp-servers", { method: "POST", body: JSON.stringify(data) }),
    update: (name: string, data: Partial<McpServerIn>) =>
      request<McpServer>(`/mcp-servers/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (name: string) =>
      request<{ deleted: boolean }>(`/mcp-servers/${encodeURIComponent(name)}`, { method: "DELETE" }),
    registry: (params?: { q?: string; cursor?: string; fresh?: boolean }) => {
      const qs = new URLSearchParams();
      if (params?.q) qs.set("q", params.q);
      if (params?.cursor) qs.set("cursor", params.cursor);
      if (params?.fresh) qs.set("fresh", "1");
      const suffix = qs.toString() ? `?${qs}` : "";
      return request<{ entries: McpRegistryEntry[]; nextCursor?: string }>(`/mcp-servers/registry${suffix}`);
    },
  },

  integrations: {
    list: () => request<IntegrationsListResponse>("/integrations"),
    save: (name: string, values: Record<string, string>) =>
      request<IntegrationStatus>(`/integrations/${encodeURIComponent(name)}`, {
        method: "PUT", body: JSON.stringify(values),
      }),
    delete: (name: string) =>
      request<{ deleted: boolean }>(`/integrations/${encodeURIComponent(name)}`, { method: "DELETE" }),
    test: (name: string) =>
      request<{ ok: boolean; error?: string; detail?: Record<string, unknown> }>(
        `/integrations/${encodeURIComponent(name)}/test`, { method: "POST", body: "{}" },
      ),
    gmailOauthStart: (creds: { client_id?: string; client_secret?: string }) =>
      request<{ authorize_url: string; state: string; redirect_uri: string }>(
        `/integrations/gmail/oauth/start`,
        { method: "POST", body: JSON.stringify(creds) },
      ),
    gmailOauthStatus: (state: string) =>
      request<{ status: "pending" | "done" | "error" | "unknown"; error?: string }>(
        `/integrations/gmail/oauth/status?state=${encodeURIComponent(state)}`,
      ),
    outlookOauthStart: (creds: { client_id?: string; client_secret?: string }) =>
      request<{ authorize_url: string; state: string; redirect_uri: string }>(
        `/integrations/outlook/oauth/start`,
        { method: "POST", body: JSON.stringify(creds) },
      ),
    outlookOauthStatus: (state: string) =>
      request<{ status: "pending" | "done" | "error" | "unknown"; error?: string }>(
        `/integrations/outlook/oauth/status?state=${encodeURIComponent(state)}`,
      ),
  },

  envSync: {
    preview: () => request<EnvSyncResult>("/env-sync"),
    apply: () => request<EnvSyncResult>("/env-sync", { method: "POST", body: "{}" }),
  },

  pending: {
    list: (status?: "pending" | "approved" | "denied" | "failed") =>
      request<PendingAction[]>(`/pending-actions${status ? `?status=${status}` : ""}`),
    // ADR-0010: `extras` carries approval-time secret material (provider keys,
    // integration credentials) that the agent never sees. The route forwards
    // it to applyAction; the agent's pending_actions.payload stays clean.
    approve: (id: string, extras?: Record<string, unknown>) =>
      request<PendingAction>(
        `/pending-actions/${encodeURIComponent(id)}/approve`,
        { method: "POST", body: JSON.stringify(extras ? { extras } : {}) },
      ),
    deny: (id: string) =>
      request<PendingAction>(`/pending-actions/${encodeURIComponent(id)}/deny`, { method: "POST", body: "{}" }),
  },

  scheduledTasks: {
    list: (agent_id?: string) =>
      request<ScheduledTask[]>(`/scheduled-tasks${agent_id ? `?agent_id=${encodeURIComponent(agent_id)}` : ""}`),
    update: (id: string, patch: Partial<Pick<ScheduledTask, "prompt" | "description" | "kind" | "schedule" | "enabled">>) =>
      request<ScheduledTask>(`/scheduled-tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    cancel: (id: string) =>
      request<{ deleted: boolean }>(`/scheduled-tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    runNow: (id: string) =>
      request<{ accepted: boolean; task_id: string }>(`/scheduled-tasks/${encodeURIComponent(id)}/run`, { method: "POST", body: "{}" }),
  },

  githubCopilotAuth: {
    status: () => request<{ signed_in: boolean; stored_at: string | null }>("/providers/github-copilot/auth"),
    start: () => request<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>(
      "/providers/github-copilot/auth", { method: "POST", body: "{}" },
    ),
    poll: (device_code: string) => request<{ status: string; access_token?: string; error?: string }>(
      "/providers/github-copilot/auth", { method: "PUT", body: JSON.stringify({ device_code }) },
    ),
    signOut: () => request<{ deleted: boolean }>("/providers/github-copilot/auth", { method: "DELETE" }),
  },

  bridges: {
    list: () => request<Bridge[]>("/bridges"),
    get: (id: string) => request<Bridge>(`/bridges/${encodeURIComponent(id)}`),
    create: (data: BridgeIn) =>
      request<Bridge>("/bridges", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, patch: BridgePatch) =>
      request<Bridge>(`/bridges/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    delete: (id: string) =>
      request<{ deleted: boolean }>(`/bridges/${encodeURIComponent(id)}`, { method: "DELETE" }),
    status: (id: string) => request<BridgeLiveStatus>(`/bridges/${encodeURIComponent(id)}/status`),
    pair: (id: string) =>
      request<{ accepted: boolean }>(`/bridges/${encodeURIComponent(id)}/pair`, { method: "POST", body: "{}" }),
    chats: (id: string) => request<BridgeChatsResponse>(`/bridges/${encodeURIComponent(id)}/chats`),
    lookup: (id: string, phone: string) =>
      request<{ chat: import("./types").BridgeChat | null }>(
        `/bridges/${encodeURIComponent(id)}/lookup`,
        { method: "POST", body: JSON.stringify({ phone }) },
      ),

    routes: {
      list: (bridge_id: string) =>
        request<BridgeRoute[]>(`/bridges/${encodeURIComponent(bridge_id)}/routes`),
      create: (bridge_id: string, data: BridgeRouteIn) =>
        request<BridgeRoute>(`/bridges/${encodeURIComponent(bridge_id)}/routes`, {
          method: "POST", body: JSON.stringify(data),
        }),
      update: (bridge_id: string, route_id: string, patch: BridgeRoutePatch) =>
        request<BridgeRoute>(
          `/bridges/${encodeURIComponent(bridge_id)}/routes/${encodeURIComponent(route_id)}`,
          { method: "PATCH", body: JSON.stringify(patch) },
        ),
      delete: (bridge_id: string, route_id: string) =>
        request<{ deleted: boolean }>(
          `/bridges/${encodeURIComponent(bridge_id)}/routes/${encodeURIComponent(route_id)}`,
          { method: "DELETE" },
        ),
    },
  },

  tailscale: {
    status: () => request<import("./types").TailscaleStatus>("/tailscale"),
  },

  proxy: {
    get: () => request<import("./types").ProxyConfigEnvelope>("/proxy-config"),
    save: (input: import("./types").ProxyConfigInput) =>
      request<import("./types").ProxyConfigEnvelope>("/proxy-config", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    clear: () =>
      request<import("./types").ProxyConfigEnvelope & { deleted: boolean }>("/proxy-config", {
        method: "DELETE",
      }),
  },
};


// ---------------------------------------------------------------------------
// Agent run streaming — CQRS transport (ADR-0008)
// ---------------------------------------------------------------------------
//
// One turn = one POST (submit) + one EventSource (subscribe). The previous
// WS sidecar / SSE-over-POST / SSE-GET-reattach trio is gone; EventSource
// is the only WebKit-native streaming primitive that survives iOS Safari +
// HTTP/2 reverse-proxies (Tailscale serve), so we route every browser
// through it.

export interface SubmitResult {
  /** true iff the server accepted ownership of this turn (HTTP 202). */
  accepted: boolean;
  /** Present on non-2xx outcomes. `run_in_flight` = another tab/device
   *  owns the current turn; caller should re-queue and still subscribe to
   *  observe live deltas. */
  code?: "run_in_flight" | string;
  error?: string;
}

/** POST /threads/:id/run — registers a run and returns immediately. The
 *  caller is expected to follow up with `subscribeRun()` to receive the
 *  chunk stream. Idempotent in the sense that two simultaneous submissions
 *  for the same thread will see one 202 and one 409 (`run_in_flight`). */
export async function submitRun(
  thread_id: string,
  message: string,
  signal: AbortSignal,
  stream_options?: StreamOptions,
  attachments?: ContentPart[],
): Promise<SubmitResult> {
  const res = await fetch(`${BASE}/threads/${thread_id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, stream_options, attachments }),
    signal,
  });
  // 2xx = accepted (currently always 202); 409 = already running. We treat
  // every other status as a hard error so the consumer's catch fires.
  if (res.status === 202) {
    // Drain the body to free the connection — Next.js sends a small JSON
    // ack but we don't need anything from it.
    try { await res.json(); } catch { /* ignore */ }
    return { accepted: true };
  }
  let body: { code?: string; error?: string } = {};
  try { body = (await res.json()) as { code?: string; error?: string }; } catch { /* */ }
  if (res.status === 409) {
    return { accepted: false, code: body.code ?? "run_in_flight" };
  }
  throw new Error(`${res.status} ${body.error ?? res.statusText}`);
}

/** GET /threads/:id/run — opens an `EventSource` and yields raw `data:`
 *  payloads (one JSON event per yield). Closes the source when the consumer
 *  stops iterating (either via `break` after a terminal `done`/`error`, or
 *  when the abort signal fires).
 *
 *  EventSource handles its own reconnection on transient drops. The
 *  server-side run keeps publishing into the registry across drops, so a
 *  resumed connection replays buffered chunks via `subscribe()` and the
 *  consumer sees the run through to its terminal event.
 *
 *  `stream_options` filter flags ride as query params (`show_tools`,
 *  `show_thinking`); the rest of `StreamOptions` is meaningful only on the
 *  POST and is ignored here.
 */
export function subscribeRun(
  thread_id: string,
  signal: AbortSignal,
  stream_options?: StreamOptions,
): AsyncGenerator<string> {
  const params = new URLSearchParams();
  const includeTools = stream_options?.filters?.include_tools;
  const includeThinking = stream_options?.filters?.include_thinking;
  if (includeTools === false) params.set("show_tools", "false");
  if (includeThinking === false) params.set("show_thinking", "false");
  const qs = params.toString();
  const url = `${BASE}/threads/${thread_id}/run${qs ? `?${qs}` : ""}`;

  return (async function* () {
    const queue: string[] = [];
    const waiters: Array<() => void> = [];
    let done = false;
    let streamError: Error | null = null;
    const notify = () => { while (waiters.length > 0) waiters.shift()?.(); };

    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (e) => {
      if (typeof e.data === "string") {
        queue.push(e.data);
        try {
          const parsed = JSON.parse(e.data) as { type?: string };
          if (parsed.type === "done" || parsed.type === "error") {
            done = true;
          }
        } catch { /* let consumer surface parse errors */ }
        notify();
      }
    };
    // EventSource auto-reconnects on transient network drops. We only treat
    // it as a hard error if the *first* connect attempt fails (no successful
    // 'open' ever fired) — anything after that is a recoverable drop and
    // the server's replay buffer will deliver missed chunks on reconnect.
    let everOpened = false;
    es.onopen = () => { everOpened = true; };
    es.onerror = () => {
      if (!everOpened) {
        streamError = new Error("EventSource failed to open");
        done = true;
        notify();
      }
      // else: ignore — EventSource will try to reconnect.
    };

    const onAbort = () => {
      done = true;
      try { es.close(); } catch { /* */ }
      notify();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        if (streamError) throw streamError;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      if (streamError) throw streamError;
    } finally {
      signal.removeEventListener("abort", onAbort);
      try { es.close(); } catch { /* */ }
    }
  })();
}