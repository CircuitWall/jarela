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

// ADR-0052 — request resilience.
//
// Defaults: 30s wall-clock timeout, 3 attempts on transient failures
// (network errors, 502/503, 429). Mutating verbs (POST/PUT/PATCH/DELETE)
// retry only on network errors and 503 — never on 429 (we don't want a
// duplicate write if the first one actually succeeded but the response
// was rate-limited). GET/HEAD retry on every transient class.
//
// `JARELA_DISABLE_CLIENT_RETRY=1` disables auto-retry entirely (operator
// escape hatch for the rare case where retry behaviour is masking a real
// bug they're trying to debug).

// JARELA_HTTP_REQUEST_TIMEOUT_MS / JARELA_HTTP_MAX_ATTEMPTS override these
// via runtime-config (fetched once from /api/v1/config). The fallback is
// the schema default so behavior is identical until the fetch lands.
import { runtimeConfig } from "./runtime-config";
function requestTimeoutMs(): number { return runtimeConfig().httpRequestTimeoutMs; }
function maxRequestAttempts(): number { return runtimeConfig().httpMaxAttempts; }
const RETRY_BACKOFFS_MS = [250, 1_000, 4_000];

const SAFE_METHODS = new Set(["GET", "HEAD"]);

function isClientRetryDisabled(): boolean {
  if (typeof process === "undefined" || !process.env) return false;
  return process.env.JARELA_DISABLE_CLIENT_RETRY === "1";
}

export class ApiRequestError extends Error {
  /** "network" for connection-level failures, "http" for non-2xx responses, "timeout" for the per-request deadline. */
  readonly kind: "network" | "http" | "timeout";
  /** HTTP status when kind === "http"; undefined otherwise. */
  readonly status?: number;
  constructor(kind: "network" | "http" | "timeout", message: string, status?: number) {
    super(message);
    this.name = "ApiRequestError";
    this.kind = kind;
    this.status = status;
  }
}

function isTransientStatus(status: number, method: string): boolean {
  if (status === 502 || status === 503 || status === 504) return true;
  if (status === 429 && SAFE_METHODS.has(method.toUpperCase())) return true;
  return false;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const retryDisabled = isClientRetryDisabled();
  const maxAttempts = retryDisabled ? 1 : maxRequestAttempts();
  const REQUEST_TIMEOUT_MS = requestTimeoutMs();

  // Compose the caller's signal (if any) with a per-request timeout. The
  // timeout signal aborts the underlying fetch on deadline; the caller's
  // signal lets components cancel still-pending requests on unmount.
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const timeoutCtrl = new AbortController();
    const timeoutHandle = setTimeout(() => timeoutCtrl.abort("request_timeout"), REQUEST_TIMEOUT_MS);
    const composed = init?.signal
      ? composeSignals(init.signal, timeoutCtrl.signal)
      : timeoutCtrl.signal;
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { "Content-Type": "application/json", ...init?.headers },
        ...init,
        signal: composed,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        // Transient HTTP — back off and retry, but only on safe methods for
        // 429 (a 429 on POST might mean the request DID land but the response
        // got rate-limited; replaying could double-write).
        if (attempt < maxAttempts - 1 && isTransientStatus(res.status, method)) {
          await sleep(RETRY_BACKOFFS_MS[attempt] ?? RETRY_BACKOFFS_MS[RETRY_BACKOFFS_MS.length - 1]);
          continue;
        }
        throw new ApiRequestError("http", `${res.status} ${text}`, res.status);
      }
      return res.json() as Promise<T>;
    } catch (err) {
      lastErr = err;
      // User-initiated abort (caller cancelled) — never retry.
      if (init?.signal?.aborted) {
        const e = new ApiRequestError("network", "request aborted by caller");
        e.name = "AbortError";
        throw e;
      }
      // Per-request timeout fired.
      if (timeoutCtrl.signal.aborted && err instanceof Error && err.name === "AbortError") {
        if (attempt < maxAttempts - 1) {
          await sleep(RETRY_BACKOFFS_MS[attempt] ?? RETRY_BACKOFFS_MS[RETRY_BACKOFFS_MS.length - 1]);
          continue;
        }
        throw new ApiRequestError("timeout", `request to ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      // ApiRequestError from the !ok branch above falls through unchanged.
      if (err instanceof ApiRequestError) throw err;
      // Network-level failure (TypeError "fetch failed", DNS failure, etc.).
      // Retry every method (network failures don't carry the "did the write
      // land?" ambiguity that 429-on-POST does).
      if (attempt < maxAttempts - 1) {
        await sleep(RETRY_BACKOFFS_MS[attempt] ?? RETRY_BACKOFFS_MS[RETRY_BACKOFFS_MS.length - 1]);
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiRequestError("network", msg);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
  // Unreachable in practice (the loop always either returns or throws), but
  // appease the compiler. Re-throw whatever the last attempt produced.
  throw lastErr instanceof Error ? lastErr : new ApiRequestError("network", "request failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Compose two AbortSignals into one that fires when EITHER aborts. Replaces
// AbortSignal.any() which is Node-22+; we keep this manual version so the
// client lib stays portable across older runtimes.
function composeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onA = () => ctrl.abort(a.reason);
  const onB = () => ctrl.abort(b.reason);
  a.addEventListener("abort", onA, { once: true });
  b.addEventListener("abort", onB, { once: true });
  return ctrl.signal;
}

export const api = {
  agents: {
    list: (opts?: { force?: boolean }) =>
      cachedList(agentListCache, () => request<AgentConfig[]>("/agents"), setAgentListCache, opts?.force === true),
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
    // ADR-0046. Pin or clear the thread's long-task goal. The goal is
    // injected into every subsequent turn's system prompt outside the tier
    // budget so it can't be compacted away as the thread grows.
    setTaskGoal: (thread_id: string, task_goal: string | null) =>
      request<{ task_goal: string | null }>(
        `/threads/${thread_id}/task-goal`,
        { method: "PATCH", body: JSON.stringify({ task_goal }) },
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
    catalog: (provider: string) => request<import("./types").CatalogModel[]>(`/providers/${encodeURIComponent(provider)}/models`),
    create: async (name: string, data: ModelConfigIn) => {
      const created = await request<ModelConfig>("/models", { method: "POST", body: JSON.stringify({ name, ...data }) });
      if (modelListCache.data) setModelListCache([...modelListCache.data, created]);
      else if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:models-changed"));
      return created;
    },
    update: async (name: string, data: ModelConfigIn) => {
      const updated = await request<ModelConfig>(`/models/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(data) });
      if (modelListCache.data) setModelListCache(modelListCache.data.map((m) => (m.name === name ? updated : m)));
      else if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:models-changed"));
      return updated;
    },
    delete: async (name: string) => {
      const res = await request<{ deleted: boolean }>(`/models/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (res.deleted) {
        if (modelListCache.data) setModelListCache(modelListCache.data.filter((m) => m.name !== name));
        else if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jarela:models-changed"));
        // Deleting a model cascades to its assignments server-side; drop the
        // task list cache so the next read reflects the server.
        if (taskListCache.data) setTaskListCache(taskListCache.data.filter((t) => t.model_config_name !== name));
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

    // Connect-timeout safety net. EventSource stays in CONNECTING forever
    // when the server is unreachable (DNS / TLS handshake stuck / proxy
    // black-holing the GET / …) — without this we'd hang the UI gate.
    //
    // The previous 8s deadline mis-fired under legitimate slow-paths:
    // cold-boot of the run route (LangGraph init, sqlite open, MCP server
    // load, agent first-token) can push the SSE-header flush well past 8s
    // on corp proxies. The agent then completes server-side but the client
    // already gave up — user sees a scary toast, no live view, no obvious
    // recovery path. The kill timer becomes a false-positive.
    //
    // Raised to 30s (generous cold-boot envelope) to cut those false hits.
    // If onopen genuinely never fires in 30s, the server is wedged and a
    // hard fail is correct.
    let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      connectTimer = null;
      if (!everOpened && !done) {
        streamError = new Error("EventSource connect timeout");
        done = true;
        try { es.close(); } catch { /* */ }
        notify();
      }
    }, runtimeConfig().sseConnectTimeoutMs);

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