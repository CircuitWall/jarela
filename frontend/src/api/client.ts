import type { AgentInfo, MemoryItem, ModelConfig, ThreadDetail, ThreadSummary } from "./types";

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
    list: () => request<AgentInfo[]>("/agents"),
  },

  threads: {
    list: (limit = 50, offset = 0) =>
      request<ThreadSummary[]>(`/threads?limit=${limit}&offset=${offset}`),
    create: (agent_id: string, title?: string) =>
      request<ThreadSummary>("/threads", {
        method: "POST",
        body: JSON.stringify({ agent_id, title }),
      }),
    get: (thread_id: string) => request<ThreadDetail>(`/threads/${thread_id}`),
    delete: (thread_id: string) =>
      request<{ deleted: boolean }>(`/threads/${thread_id}`, { method: "DELETE" }),
  },

  memory: {
    list: (namespace?: string, search?: string, limit = 50) => {
      const params = new URLSearchParams();
      if (namespace) params.set("namespace", namespace);
      if (search) params.set("search", search);
      params.set("limit", String(limit));
      return request<MemoryItem[]>(`/memory?${params}`);
    },
    create: (namespace: string, key: string, value: unknown) =>
      request<MemoryItem>("/memory", {
        method: "POST",
        body: JSON.stringify({ namespace, key, value }),
      }),
    update: (namespace: string, key: string, value: unknown) =>
      request<MemoryItem>(`/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      }),
    delete: (namespace: string, key: string) =>
      request<{ deleted: boolean }>(
        `/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
        { method: "DELETE" }
      ),
  },
};

export async function* streamChat(
  thread_id: string,
  message: string,
  signal: AbortSignal
): AsyncGenerator<string> {
  const res = await fetch(`${BASE}/threads/${thread_id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${text}`);
  }

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
          if (!raw || raw === "[DONE]") continue;
          yield raw;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
