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
  DashboardCurrencyInfo,
  DashboardMetrics,
  DashboardPricingRefreshResult,
  ContentPart,
  EnvAllowlistConfig,
  EnvSyncResult,
  ExtensionsListResponse,
  IntegrationsListResponse,
  IntegrationStatus,
  McpRegistryEntry,
  McpServer,
  McpServerIn,
  PendingAction,
  ScheduledTask,
  Watcher,
  DocumentSource,
  DocumentSourceIn,
  DocumentSourcePatch,
  DocumentSettings,
  DocumentHit,
  DocumentReindexResult,
  MemoryItem,
  ModelConfig,
  ModelConfigIn,
  Credential,
  CredentialIn,
  StreamOptions,
  ToolInfo,
  ToolPolicy,
  ToolSecretSlotInfo,
  TaskAssignment,
  ThreadDetail,
  ThreadSummary,
  UserProfile,
  BuiltinToolCategoryInfo,
  Harness,
  HarnessIn,
  HarnessListResponse,
  HarnessPatch,
} from "./types";
import { runtimeConfig } from "./runtime-config";

const BASE = "/api/v1";

const LIST_TTL_MS = 30_000;

interface ListCache<T> {
  data: T[] | null;
  fetchedAt: number;
  inflight: Promise<T[]> | null;
}

function emptyCache<T>(): ListCache<T> {
  return { data: null, fetchedAt: 0, inflight: null };
}

function cloneRows<T>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row }));
}

const agentListCache: ListCache<AgentConfig> = emptyCache();
const modelListCache: ListCache<ModelConfig> = emptyCache();
const taskListCache: ListCache<TaskAssignment> = emptyCache();

function setAgentListCache(rows: AgentConfig[], notify = true): AgentConfig[] {
  const snap = cloneRows(rows);
  agentListCache.data = snap;
  agentListCache.fetchedAt = Date.now();
  agentListCache.inflight = null;
  if (notify && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("jarela:agents-changed"));
  }
  return cloneRows(snap);
}

function setModelListCache(rows: ModelConfig[], notify = true): ModelConfig[] {
  const snap = cloneRows(rows);
  modelListCache.data = snap;
  modelListCache.fetchedAt = Date.now();
  modelListCache.inflight = null;
  if (notify && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("jarela:models-changed"));
  }
  return cloneRows(snap);
}

function setTaskListCache(rows: TaskAssignment[], notify = true): TaskAssignment[] {
  const snap = cloneRows(rows);
  taskListCache.data = snap;
  taskListCache.fetchedAt = Date.now();
  taskListCache.inflight = null;
  if (notify && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("jarela:tasks-changed"));
  }
  return cloneRows(snap);
}

function cachedList<T>(
  cache: ListCache<T>,
  fetchFn: () => Promise<T[]>,
  setCache: (rows: T[], notify?: boolean) => T[],
  force: boolean,
): Promise<T[]> {
  const now = Date.now();
  if (!force && cache.data && now - cache.fetchedAt < LIST_TTL_MS) {
    return Promise.resolve(cloneRows(cache.data));
  }
  if (!force && cache.inflight) return cache.inflight;
  const req = fetchFn().then((rows) => setCache(rows, false));
  cache.inflight = req;
  return req;
}

// Retry classifier matching the JARELA_HTTP_MAX_ATTEMPTS schema description:
// network errors, 5xx, and 429. 4xx (client errors) and 408 are not retried —
// the request is well-formed but the server says no, retrying won't change
// that. AbortError is also not retried (the caller cancelled deliberately).
function isRetryable(err: unknown, status?: number): boolean {
  if (status !== undefined) return status >= 500 || status === 429;
  if (err instanceof DOMException && err.name === "AbortError") return false;
  return true; // network errors / fetch rejections
}

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const cfg = runtimeConfig();
  const maxAttempts = Math.max(1, cfg.httpMaxAttempts);
  const timeoutMs = init?.timeoutMs ?? cfg.httpRequestTimeoutMs;
  const { timeoutMs: _ignoreTimeoutMs, ...fetchInit } = init ?? {};
  const callerSignal = fetchInit.signal ?? null;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Per-attempt timeout. Respect a caller-supplied AbortSignal too —
    // if the caller cancels, we abort whichever attempt is in flight and
    // bail out of the retry loop immediately.
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    const onCallerAbort = () => timeoutCtrl.abort();
    callerSignal?.addEventListener("abort", onCallerAbort);

    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { "Content-Type": "application/json", ...fetchInit.headers },
        ...fetchInit,
        signal: timeoutCtrl.signal,
      });
      if (!res.ok) {
        // 423 lock states: distinct events so AppShell can mount the
        // right overlay (decrypt vs presence-check). Both throw so the
        // caller still sees the failure — no point retrying, the lock
        // isn't going to clear on its own.
        if (res.status === 423) {
          const cloned = res.clone();
          const body = (await cloned.json().catch(() => null)) as
            | { error?: string }
            | null;
          if (typeof window !== "undefined") {
            if (body?.error === "screen-locked") {
              window.dispatchEvent(new CustomEvent("jarela:screen-locked"));
            } else if (body?.error === "locked") {
              window.dispatchEvent(new CustomEvent("jarela:master-key-locked"));
            }
          }
          throw new Error(`423 ${body?.error ?? "locked"}`);
        }
        const text = await res.text().catch(() => res.statusText);
        // Retryable status codes: try again unless we've burned the budget
        // or the caller aborted.
        if (attempt < maxAttempts && isRetryable(null, res.status) && !callerSignal?.aborted) {
          lastErr = new Error(`${res.status} ${text}`);
          continue;
        }
        throw new Error(`${res.status} ${text}`);
      }
      return res.json() as Promise<T>;
    } catch (err) {
      // Bail out immediately on caller cancel — never report it as a
      // network failure.
      if (callerSignal?.aborted) throw err;
      lastErr = err;
      if (attempt < maxAttempts && isRetryable(err)) continue;
      throw err;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
  // Unreachable: the loop either returns or throws on every attempt.
  throw lastErr ?? new Error("request failed");
}

export const api = {
  agents: {
    list: (opts?: { force?: boolean }) =>
      cachedList(agentListCache, () => request<AgentConfig[]>("/agents"), setAgentListCache, opts?.force === true),
    get: (id: string) => request<AgentConfig>(`/agents/${encodeURIComponent(id)}`),
    create: async (data: AgentConfigIn) => {
      const created = await request<AgentConfig>("/agents", { method: "POST", body: JSON.stringify(data) });
      if (agentListCache.data) setAgentListCache([...agentListCache.data, created]);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:agents-changed"));
      return created;
    },
    update: async (id: string, data: AgentConfigIn) => {
      const updated = await request<AgentConfig>(`/agents/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(data) });
      if (agentListCache.data) setAgentListCache(agentListCache.data.map((a) => (a.id === id ? updated : a)));
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:agents-changed"));
      return updated;
    },
    delete: async (id: string) => {
      const res = await request<{ deleted: boolean }>(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.deleted) {
        if (agentListCache.data) setAgentListCache(agentListCache.data.filter((a) => a.id !== id));
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:agents-changed"));
      }
      return res;
    },
    getThread: (id: string) =>
      request<ThreadSummary>(`/agents/${encodeURIComponent(id)}/thread`),
    compact: (id: string) =>
      request<{
        compacted: boolean;
        summary?: string;
        reason?: string;
        message_count?: number;
        context_chars?: number;
        pruned?: number;
        archive_pruned?: number;
        hot_since?: string | null;
        warm_summary?: string | null;
        warm_summary_before?: string | null;
        warm_summary_computed_at?: string | null;
        warm_summary_source_messages?: number | null;
        warm_summary_source_chars?: number | null;
      }>(
        `/agents/${encodeURIComponent(id)}/compact`,
        // Conversation summarization can take longer than normal API calls,
        // so avoid tripping the default HTTP timeout for large threads.
        { method: "POST", body: "{}", timeoutMs: 180_000 },
      ),
  },

  tools: {
    list: () => request<ToolInfo[]>("/tools"),
  },

  builtinTools: {
    list: () => request<BuiltinToolCategoryInfo[]>("/builtin-tools"),
    setEnabled: (category: string, enabled: boolean) =>
      request<{ category: string; enabled: boolean }>("/builtin-tools", {
        method: "PATCH",
        body: JSON.stringify({ category, enabled }),
      }),
  },

  extensions: {
    list: () => request<ExtensionsListResponse>("/extensions"),
    getToolSecrets: (name: string) =>
      request<{ name: string; secrets: ToolSecretSlotInfo[] }>(
        `/extensions/tools/${encodeURIComponent(name)}/secrets`,
      ),
    saveToolSecrets: (name: string, values: Record<string, string>) =>
      request<{ name: string; secrets: ToolSecretSlotInfo[] }>(
        `/extensions/tools/${encodeURIComponent(name)}/secrets`,
        { method: "PUT", body: JSON.stringify({ values }) },
      ),
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
    // ADR-0042. Move the explicit hot/warm context boundary on this thread.
    // Pass `null` to clear the pin and let the agent's default window apply.
    // Fire-and-forget from the chat — UI updates optimistically and the
    // returned shape just confirms server-side state for resync if needed.
    setContextPin: (thread_id: string, hot_since: string | null) =>
      request<import("./types").ThreadContextPin>(
        `/threads/${thread_id}/context-pin`,
        { method: "PATCH", body: JSON.stringify({ hot_since }) },
      ),
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
    list: (opts?: { force?: boolean }) =>
      cachedList(modelListCache, () => request<ModelConfig[]>("/models"), setModelListCache, opts?.force === true),
    providers: () => request<string[]>("/providers"),
    catalog: (provider: string, overrides?: Record<string, unknown>) =>
      overrides
        ? request<import("./types").CatalogModel[]>(`/providers/${encodeURIComponent(provider)}/models`, {
            method: "POST",
            body: JSON.stringify({ params: overrides }),
          })
        : request<import("./types").CatalogModel[]>(`/providers/${encodeURIComponent(provider)}/models`),
    probe: (provider: string, model_id: string, params?: Record<string, unknown>, name?: string, credential_id?: string) =>
      request<{ ok: boolean; error?: string }>(`/providers/${encodeURIComponent(provider)}/probe`, {
        method: "POST",
        body: JSON.stringify({ model_id, params, name, credential_id }),
        timeoutMs: 20_000,
      }),
    compactThreads: (name: string, using: { provider: string; model_id: string; params?: Record<string, unknown> }) =>
      request<{ compacted: number; skipped: number; errors: Array<{ thread_id: string; error: string }> }>(
        `/models/${encodeURIComponent(name)}/compact-threads`,
        {
          method: "POST",
          body: JSON.stringify({ using }),
          timeoutMs: 120_000,
        },
      ),
    create: async (name: string, data: ModelConfigIn) => {
      const created = await request<ModelConfig>("/models", { method: "POST", body: JSON.stringify({ name, ...data }) });
      if (modelListCache.data) setModelListCache([...modelListCache.data, created]);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:models-changed"));
      return created;
    },
    update: async (name: string, data: ModelConfigIn) => {
      const updated = await request<ModelConfig>(`/models/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(data) });
      if (modelListCache.data) setModelListCache(modelListCache.data.map((m) => (m.name === name ? updated : m)));
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:models-changed"));
      return updated;
    },
    delete: async (name: string) => {
      const res = await request<{ deleted: boolean }>(`/models/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (res.deleted) {
        if (modelListCache.data) setModelListCache(modelListCache.data.filter((m) => m.name !== name));
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:models-changed"));
        // Deleting a model cascades to its assignments server-side; drop the
        // task list cache so the next read reflects the server.
        if (taskListCache.data) setTaskListCache(taskListCache.data.filter((t) => t.model_config_name !== name));
      }
      return res;
    },
  },

  credentials: {
    list: (filter?: { type?: string; provider?: string }) => {
      const qs = new URLSearchParams();
      if (filter?.type) qs.set("type", filter.type);
      if (filter?.provider) qs.set("provider", filter.provider);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<Credential[]>(`/credentials${suffix}`);
    },
    create: async (data: CredentialIn) => {
      const created = await request<Credential>("/credentials", { method: "POST", body: JSON.stringify(data) });
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:credentials-changed"));
      return created;
    },
    update: async (id: string, data: Partial<CredentialIn>) => {
      const updated = await request<Credential>(`/credentials/${encodeURIComponent(id)}`, {
        method: "PUT", body: JSON.stringify(data),
      });
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:credentials-changed"));
      return updated;
    },
    delete: async (id: string) => {
      const res = await request<{ deleted: boolean }>(`/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.deleted && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("jarela:credentials-changed"));
      }
      return res;
    },
  },

  profile: {
    get: () => request<UserProfile>("/profile"),
    update: (data: Partial<Pick<UserProfile, "name" | "icon" | "about" | "preset">>) =>
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
    list: (opts?: { force?: boolean }) =>
      cachedList(taskListCache, () => request<TaskAssignment[]>("/tasks"), setTaskListCache, opts?.force === true),
    assign: async (agent_id: string, model_config_name: string, tool_policy?: ToolPolicy) => {
      const assigned = await request<TaskAssignment>(`/tasks/${encodeURIComponent(agent_id)}`, {
        method: "PUT", body: JSON.stringify({ model_config_name, tool_policy }),
      });
      if (taskListCache.data) {
        const exists = taskListCache.data.some((t) => t.agent_id === agent_id);
        const next = exists
          ? taskListCache.data.map((t) => (t.agent_id === agent_id ? assigned : t))
          : [...taskListCache.data, assigned];
        setTaskListCache(next);
      } else if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("jarela:tasks-changed"));
      }
      return assigned;
    },
    unassign: async (agent_id: string) => {
      const res = await request<{ deleted: boolean }>(`/tasks/${encodeURIComponent(agent_id)}`, { method: "DELETE" });
      if (taskListCache.data) setTaskListCache(taskListCache.data.filter((t) => t.agent_id !== agent_id));
      else if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:tasks-changed"));
      return res;
    },
  },

  dashboard: {
    metrics: (days = 30) => request<DashboardMetrics>(`/dashboard/metrics?days=${encodeURIComponent(String(days))}`),
    refreshPricing: (opts?: { force?: boolean; ttlDays?: number }) => {
      const qs = new URLSearchParams();
      if (opts?.force === true) qs.set("force", "1");
      if (typeof opts?.ttlDays === "number" && Number.isFinite(opts.ttlDays)) qs.set("ttlDays", String(opts.ttlDays));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<DashboardPricingRefreshResult>(`/dashboard/pricing${suffix}`, {
        method: "POST",
        body: "{}",
      });
    },
    currency: (opts?: { lat?: number | null; lng?: number | null; currency?: string | null }) => {
      const qs = new URLSearchParams();
      if (typeof opts?.lat === "number" && Number.isFinite(opts.lat)) qs.set("lat", String(opts.lat));
      if (typeof opts?.lng === "number" && Number.isFinite(opts.lng)) qs.set("lng", String(opts.lng));
      if (opts?.currency) qs.set("currency", opts.currency);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<DashboardCurrencyInfo>(`/dashboard/currency${suffix}`);
    },
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
    allowlist: {
      get: () => request<EnvAllowlistConfig>("/env-sync/allowlist"),
      set: (integration: string, field: string, envVars: string[]) =>
        request<EnvAllowlistConfig>("/env-sync/allowlist", {
          method: "PUT",
          body: JSON.stringify({ integration, field, envVars }),
        }),
    },
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
    // ADR-0032 — patch supports the reaction discriminator. Mirrors the
    // watchers.update shape; explicit reaction_kind triggers a full replace.
    update: (id: string, patch: Partial<Pick<ScheduledTask, "agent_id" | "prompt" | "description" | "kind" | "schedule" | "enabled" | "silent">> & {
      reaction_kind?: "agent_prompt" | "script";
      reaction_script?: string | null;
      reaction_script_args?: Record<string, unknown> | null;
    }) =>
      request<ScheduledTask>(`/scheduled-tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    cancel: (id: string) =>
      request<{ deleted: boolean }>(`/scheduled-tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    runNow: (id: string) =>
      request<{ accepted: boolean; task_id: string }>(`/scheduled-tasks/${encodeURIComponent(id)}/run`, { method: "POST", body: "{}" }),
  },

  // Event-driven watchers (ADR-0027). Polls a built-in tool every N
  // seconds; only fires the agent when the tool output changes.
  watchers: {
    list: (agent_id?: string) =>
      request<Watcher[]>(`/watchers${agent_id ? `?agent_id=${encodeURIComponent(agent_id)}` : ""}`),
    create: (data: {
      agent_id: string;
      label: string;
      tool: string;
      args?: Record<string, unknown>;
      every_seconds: number;
      silent?: boolean;
      reaction_kind?: "agent_prompt" | "script";
      reaction_prompt?: string | null;
      reaction_script?: string | null;
      reaction_script_args?: Record<string, unknown> | null;
    }) =>
      request<Watcher>("/watchers", { method: "POST", body: JSON.stringify(data) }),
    update: (
      id: string,
      patch: Partial<{
        agent_id: string;
        label: string;
        interval_seconds: number;
        enabled: boolean;
        silent: boolean;
        reaction_kind: "agent_prompt" | "script";
        reaction_prompt: string | null;
        reaction_script: string | null;
        reaction_script_args: Record<string, unknown> | null;
      }>,
    ) =>
      request<Watcher>(`/watchers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    cancel: (id: string) =>
      request<{ deleted: boolean }>(`/watchers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    runNow: (id: string) =>
      request<{ accepted: boolean; watcher_id: string }>(`/watchers/${encodeURIComponent(id)}/run`, { method: "POST", body: "{}" }),
    // ADR-0031: list registered reaction scripts (`reaction.*` namespace)
    // for the watcher UI's reaction-kind picker.
    listReactionScripts: () =>
      request<{ scripts: string[] }>("/watchers/reaction-scripts"),
  },

  // Document RAG (ADR-0024). Folder sources are scanned by the scheduler
  // every ~10 minutes; the search endpoint is a thin wrapper over the
  // `documents_search` tool so callers can preview hits without invoking
  // an agent.
  documents: {
    listSources: () => request<DocumentSource[]>("/documents/sources"),
    createSource: (data: DocumentSourceIn) =>
      request<DocumentSource>("/documents/sources", { method: "POST", body: JSON.stringify(data) }),
    updateSource: (id: string, patch: DocumentSourcePatch) =>
      request<DocumentSource>(`/documents/sources/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteSource: (id: string) =>
      request<{ deleted: boolean }>(`/documents/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
    reindex: (id: string) =>
      request<DocumentReindexResult>(`/documents/sources/${encodeURIComponent(id)}/reindex`, { method: "POST", body: "{}" }),
    search: (q: string, opts?: { limit?: number; source_id?: string }) => {
      const p = new URLSearchParams({ q });
      if (opts?.limit) p.set("limit", String(opts.limit));
      if (opts?.source_id) p.set("source_id", opts.source_id);
      return request<{ query: string; hits: DocumentHit[] }>(`/documents/search?${p.toString()}`);
    },
    getSettings: () => request<DocumentSettings>("/documents/settings"),
    setSettings: (patch: DocumentSettings) =>
      request<DocumentSettings>("/documents/settings", { method: "PUT", body: JSON.stringify(patch) }),
  },

  // Filesystem browse — backs the folder-picker dialog in the Documents
  // panel. Lists immediate subdirectories at an absolute path.
  fs: {
    browse: (p?: string) => {
      const qs = p ? `?path=${encodeURIComponent(p)}` : "";
      return request<{
        path: string;
        parent: string | null;
        home: string;
        entries: { name: string; path: string }[];
      }>(`/fs/browse${qs}`);
    },
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

  harnesses: {
    list: () => request<HarnessListResponse>("/harnesses"),
    get: (id: string) => request<Harness>(`/harnesses/${encodeURIComponent(id)}`),
    create: (data: HarnessIn) =>
      request<Harness>("/harnesses", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, patch: HarnessPatch) =>
      request<Harness>(`/harnesses/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    delete: (id: string) =>
      request<{ deleted: boolean }>(`/harnesses/${encodeURIComponent(id)}`, { method: "DELETE" }),
    setDefault: (id: string) =>
      request<{ id: string }>("/harnesses/default", {
        method: "PUT",
        body: JSON.stringify({ id }),
      }),
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

  allowedSites: {
    list: () =>
      request<{ sites: import("./types").AllowedSiteStatus[] }>("/allowed-sites"),
    add: (input: { hostname: string; ssrf_bypass?: boolean }) =>
      request<{ site: import("./types").AllowedSiteStatus }>("/allowed-sites", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    remove: (hostname: string) =>
      request<{ deleted: boolean }>(`/allowed-sites/${encodeURIComponent(hostname)}`, {
        method: "DELETE",
      }),
    setSsrfBypass: (hostname: string, ssrf_bypass: boolean) =>
      request<{ ok: boolean }>(`/allowed-sites/${encodeURIComponent(hostname)}`, {
        method: "PATCH",
        body: JSON.stringify({ ssrf_bypass }),
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
  hot_since?: string | null,
): Promise<SubmitResult> {
  const res = await fetch(`${BASE}/threads/${thread_id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, stream_options, attachments, hot_since }),
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
    // EXCEPT when the browser flips readyState to CLOSED — that's the spec's
    // terminal state (e.g. the reconnect attempt got a 404 because the run
    // finished + TTL-evicted), and no further events will ever arrive. If
    // we ignored that case the consumer would hang on the waiter forever
    // and the UI activity label ("Reconnecting…") would never clear.
    let everOpened = false;
    es.onopen = () => {
      everOpened = true;
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        done = true;
        notify();
        return;
      }
      if (!everOpened) {
        streamError = new Error("EventSource failed to open");
        done = true;
        notify();
      }
      // else: ignore — EventSource will try to reconnect.
    };

    // Connect-timeout safety net: if onopen hasn't fired within the
    // configured window the server is unreachable (DNS, TLS handshake
    // stuck, proxy black-holing the GET, dev-server still compiling the
    // route, …). EventSource alone won't surface that — it stays in
    // CONNECTING forever, retrying silently. Force the iterator to fail
    // so the caller's catch/finally can release the UI gate. The window
    // is tunable via JARELA_SSE_CONNECT_TIMEOUT_MS (default 30s) so dev
    // cold-compiles and slow proxies don't false-positive.
    const connectTimeoutMs = runtimeConfig().sseConnectTimeoutMs;
    let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      connectTimer = null;
      if (!everOpened && !done) {
        // User-facing: this surfaces verbatim in the chat error toast via
        // useSSE → setError(String(err)). Avoid jargon ("EventSource") and
        // name the actual symptom — the server didn't open the response
        // stream within the connect window.
        streamError = new Error(
          `Connection timed out — the server didn't respond within ${Math.round(connectTimeoutMs / 1000)}s.`,
        );
        done = true;
        try { es.close(); } catch { /* */ }
        notify();
      }
    }, connectTimeoutMs);

    const onAbort = () => {
      done = true;
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
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
      if (connectTimer !== null) clearTimeout(connectTimer);
      signal.removeEventListener("abort", onAbort);
      try { es.close(); } catch { /* */ }
    }
  })();
}