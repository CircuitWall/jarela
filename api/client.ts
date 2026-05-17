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
    list: () => request<AgentConfig[]>("/agents"),
    get: (id: string) => request<AgentConfig>(`/agents/${encodeURIComponent(id)}`),
    create: (data: AgentConfigIn) =>
      request<AgentConfig>("/agents", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: AgentConfigIn) =>
      request<AgentConfig>(`/agents/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<{ deleted: boolean }>(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
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

  threads: {
    list: (limit = 50, offset = 0) => request<ThreadSummary[]>(`/threads?limit=${limit}&offset=${offset}`),
    create: (agent_id: string, title?: string) =>
      request<ThreadSummary>("/threads", { method: "POST", body: JSON.stringify({ agent_id, title }) }),
    get: (thread_id: string, opts?: { limit?: number; before?: string }) => {
      const p = new URLSearchParams();
      if (opts?.limit) p.set("limit", String(opts.limit));
      if (opts?.before) p.set("before", opts.before);
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
    registry: () => request<McpRegistryEntry[]>("/mcp-servers/registry"),
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
  },

  pending: {
    list: (status?: "pending" | "approved" | "denied" | "failed") =>
      request<PendingAction[]>(`/pending-actions${status ? `?status=${status}` : ""}`),
    approve: (id: string) =>
      request<PendingAction>(`/pending-actions/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" }),
    deny: (id: string) =>
      request<PendingAction>(`/pending-actions/${encodeURIComponent(id)}/deny`, { method: "POST", body: "{}" }),
  },

  scheduledTasks: {
    list: (agent_id?: string) =>
      request<ScheduledTask[]>(`/scheduled-tasks${agent_id ? `?agent_id=${encodeURIComponent(agent_id)}` : ""}`),
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
};

let cachedWsUrl: string | null = null;

// Persist the ws URL across page reloads so we don't pay an HTTP round-trip
// to /api/v1/ws on every cold load. Keyed by the current origin so a host
// flip (loopback ↔ tailscale ↔ different machine) invalidates automatically.
// Versioned so older buggy cache entries (e.g. ones pointing at port 3219
// directly through tailscale, which doesn't expose that port) are ignored
// after a client deploy that changes the URL shape.
const WS_URL_STORAGE_KEY = "langgui:ws-url:v2";

function readPersistedWsUrl(): string | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  try {
    const raw = window.sessionStorage.getItem(WS_URL_STORAGE_KEY);
    if (!raw) return null;
    const { origin, url } = JSON.parse(raw) as { origin?: string; url?: string };
    if (origin === window.location.origin && typeof url === "string") return url;
  } catch { /* ignore */ }
  return null;
}

function writePersistedWsUrl(url: string): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(
      WS_URL_STORAGE_KEY,
      JSON.stringify({ origin: window.location.origin, url }),
    );
  } catch { /* quota / private-mode — fine, fall back to in-memory cache */ }
}

async function getWsUrl(): Promise<string> {
  if (cachedWsUrl) return cachedWsUrl;
  const persisted = readPersistedWsUrl();
  if (persisted) {
    cachedWsUrl = persisted;
    return persisted;
  }
  // Bypass any SW / HTTP cache layer for the URL discovery hop. This is
  // small JSON and must reflect the live server config (post-deploy the
  // path or port may have changed).
  const res = await request<{ url: string }>("/ws", { cache: "no-store" });
  cachedWsUrl = res.url;
  writePersistedWsUrl(res.url);
  return res.url;
}

function invalidateWsUrl(): void {
  cachedWsUrl = null;
  if (typeof window !== "undefined" && window.sessionStorage) {
    try { window.sessionStorage.removeItem(WS_URL_STORAGE_KEY); } catch { /* ignore */ }
  }
}

export async function* streamChat(
  thread_id: string,
  message: string,
  signal: AbortSignal,
  stream_options?: StreamOptions,
  attachments?: ContentPart[],
): AsyncGenerator<string> {
  const res = await fetch(`${BASE}/threads/${thread_id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, stream_options, attachments }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const raw = line.slice(6).trim();
          if (raw && raw !== "[DONE]") yield raw;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* streamChatWS(
  thread_id: string,
  message: string,
  signal: AbortSignal,
  stream_options?: StreamOptions,
  attachments?: ContentPart[],
): AsyncGenerator<string> {
  const wsUrl = await getWsUrl();

  const ws = new WebSocket(wsUrl);
  const queue: string[] = [];
  const waiters: Array<() => void> = [];
  let done = false;
  let streamError: Error | null = null;
  // Track whether we received a terminal event (done/error) BEFORE the socket
  // closed. iOS Safari aggressively closes background WebSockets — when that
  // happens mid-stream the server-side run keeps going (broadcasts into the
  // registry) and we want the caller to reattach via SSE, not silently end.
  let sawTerminal = false;

  const notify = () => {
    while (waiters.length > 0) {
      waiters.shift()?.();
    }
  };

  const push = (raw: string) => {
    queue.push(raw);
    try {
      const event = JSON.parse(raw) as { type?: string };
      if (event.type === "done" || event.type === "error") {
        done = true;
        sawTerminal = true;
      }
    } catch {
      // ignore malformed payloads here and let callers surface parse errors
    }
    notify();
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({ thread_id, message, stream_options, attachments }));
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      push(event.data);
      return;
    }

    if (event.data instanceof Blob) {
      void event.data.text().then(push).catch((err) => {
        streamError = err as Error;
        done = true;
        notify();
      });
    }
  };

  ws.onerror = () => {
    streamError = new Error("WebSocket transport failed");
    done = true;
    // The URL we connected to is probably stale (server moved, proxy path
    // changed, etc.). Drop the cached entry so the next call re-discovers
    // it via GET /api/v1/ws, and so the SSE fallback in useSSE works on
    // the next attempt without a page reload.
    invalidateWsUrl();
    notify();
  };

  ws.onclose = () => {
    if (!sawTerminal && !streamError) {
      // Mid-stream drop (mobile suspend, network blip). The server-side run
      // is still going in the registry — flag a recoverable error so the
      // caller can reattach via SSE GET instead of starting a new POST run.
      streamError = Object.assign(new Error("ws closed before completion"), {
        code: "ws_drop_reattach" as const,
      });
    }
    done = true;
    notify();
  };

  signal.addEventListener("abort", () => {
    done = true;
    ws.close(1000, "aborted");
    notify();
  }, { once: true });

  while (!done || queue.length > 0) {
    if (queue.length > 0) {
      yield queue.shift() as string;
      continue;
    }

    if (streamError) {
      throw streamError;
    }

    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  if (streamError) {
    throw streamError;
  }
}
