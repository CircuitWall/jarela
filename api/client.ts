import type {
  AgentConfig,
  AgentConfigIn,
  AgentInfo,
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
      request<{ compacted: boolean; summary?: string; reason?: string }>(
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
};

let cachedWsUrl: string | null = null;

async function getWsUrl(): Promise<string> {
  if (cachedWsUrl) return cachedWsUrl;
  const res = await request<{ url: string }>("/ws");
  cachedWsUrl = res.url;
  return res.url;
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
    notify();
  };

  ws.onclose = () => {
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
