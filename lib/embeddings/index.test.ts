import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test process; embeddings module reads model_configs
// via getDefaultModelConfig (mocked below), but importing it still opens
// the DB on first use, so it needs to point at a writable tmp dir.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-embed-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const embedSpy = vi.fn();
const localEmbedSpy = vi.fn();
let resolveEmbedClient = true;

vi.mock("@/lib/providers", () => ({
  getProvider: () => ({
    embed: (model: string, texts: string[], params: unknown) =>
      embedSpy(model, texts, params),
  }),
}));

vi.mock("./local", () => ({
  embedLocally: (texts: string[], task: string) => localEmbedSpy(texts, task),
}));

vi.mock("@/lib/stores/model-config", () => ({
  getModelConfig: () => null,
  getDefaultModelConfig: () =>
    resolveEmbedClient
      ? { provider: "openai", model_id: "text-embedding-3-small", params: "{}" }
      : null,
  // resolveEmbeddingClient falls back to scanning all configured models when
  // the default can't embed. These tests mock the default directly, so an
  // empty list is the right shape — no fallback row should ever match.
  listModelConfigs: () => [],
  // The real getModelParams parses cfg.params as JSON; tests pass `"{}"` so
  // returning {} matches the production shape.
  getModelParams: () => ({}),
}));

const { _resetEmbeddingCache, _resetEmbedCaches, embed, embedQuery, embedBestEffort, embedOne, recall } = await import("./index");
const { setLocalEmbeddingsEnabled } = await import("@/lib/stores/app-settings");
const { getDb } = await import("@/lib/db");
const originalEmbeddingModelConfig = process.env.EMBEDDING_MODEL_CONFIG;

beforeEach(() => {
  embedSpy.mockReset();
  localEmbedSpy.mockReset();
  _resetEmbeddingCache();
  resolveEmbedClient = true;
  delete process.env.EMBEDDING_MODEL_CONFIG;
  setLocalEmbeddingsEnabled(false);
});

afterEach(() => {
  vi.useRealTimers();
  if (originalEmbeddingModelConfig === undefined) delete process.env.EMBEDDING_MODEL_CONFIG;
  else process.env.EMBEDDING_MODEL_CONFIG = originalEmbeddingModelConfig;
});

describe("embedBestEffort", () => {
  it("returns one vector per input on success", async () => {
    embedSpy.mockResolvedValueOnce([[0.1], [0.2], [0.3]]);
    const r = await embedBestEffort(["a", "b", "c"]);
    expect(r.vectors).toEqual([[0.1], [0.2], [0.3]]);
    expect(r.error).toBeNull();
    expect(r.failed).toBe(0);
    expect(r.terminal).toEqual([false, false, false]);
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on transient errors then succeeds", async () => {
    vi.useFakeTimers();
    embedSpy
      .mockRejectedValueOnce(new Error("HTTP 429 Too Many Requests"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce([[1], [2]]);
    const p = embedBestEffort(["x", "y"]);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.vectors).toEqual([[1], [2]]);
    expect(r.failed).toBe(0);
    expect(r.terminal).toEqual([false, false]);
    expect(embedSpy).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-transient errors, and marks the failure terminal", async () => {
    embedSpy.mockRejectedValue(new Error("HTTP 401 Unauthorized"));
    const r = await embedBestEffort(["only one"]);
    expect(r.vectors).toEqual([null]);
    expect(r.failed).toBe(1);
    expect(r.error).toContain("401");
    expect(r.terminal).toEqual([true]);
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });

  it("halves the batch on persistent failure so good inputs survive", async () => {
    embedSpy
      // whole batch of 4 fails:
      .mockRejectedValueOnce(new Error("HTTP 400 batch too large"))
      // left half of 2 fails:
      .mockRejectedValueOnce(new Error("HTTP 400 batch too large"))
      // left-left singleton ok:
      .mockResolvedValueOnce([[10]])
      // left-right singleton fails permanently:
      .mockRejectedValueOnce(new Error("HTTP 400 bad input"))
      // right half of 2 ok:
      .mockResolvedValueOnce([[30], [40]]);

    const r = await embedBestEffort(["a", "b", "c", "d"]);
    expect(r.vectors).toEqual([[10], null, [30], [40]]);
    expect(r.failed).toBe(1);
    expect(r.error).toContain("400");
    // Only the singleton that hit a genuinely bad-input error is terminal;
    // the 400s on the larger batches were "some input in here is bad" and
    // got resolved by bisection, not attributable to a specific index.
    expect(r.terminal).toEqual([false, true, false, false]);
  });

  it("pads short responses with nulls to keep indices aligned, without marking terminal", async () => {
    embedSpy.mockResolvedValueOnce([[1]]); // only 1 of 2 vectors returned
    const r = await embedBestEffort(["a", "b"]);
    expect(r.vectors).toEqual([[1], null]);
    expect(r.failed).toBe(1);
    expect(r.error).toContain("1/2");
    expect(r.terminal).toEqual([false, false]);
  });

  it("returns no-provider error when client cannot be resolved, without marking terminal", async () => {
    resolveEmbedClient = false;
    const r = await embedBestEffort(["a", "b"]);
    expect(r.vectors).toEqual([null, null]);
    expect(r.failed).toBe(2);
    expect(r.error).toBe("no embedding provider configured");
    expect(r.terminal).toEqual([false, false]);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("uses the bundled model for documents, memory, and messages when enabled", async () => {
    setLocalEmbeddingsEnabled(true);
    localEmbedSpy.mockResolvedValue([[0.25, 0.75]]);

    const indexed = await embedBestEffort(["local document chunk"]);
    const query = await embedQuery(["local search query"]);
    const memory = await embed(["memory entry"]);
    const message = await embedOne("message embedding");

    expect(indexed.vectors).toEqual([[0.25, 0.75]]);
    expect(query).toEqual([[0.25, 0.75]]);
    expect(memory).toEqual([[0.25, 0.75]]);
    expect(message).toEqual([0.25, 0.75]);
    expect(localEmbedSpy).toHaveBeenNthCalledWith(1, ["local document chunk"], "passage");
    expect(localEmbedSpy).toHaveBeenNthCalledWith(2, ["local search query"], "query");
    expect(localEmbedSpy).toHaveBeenNthCalledWith(3, ["memory entry"], "passage");
    expect(localEmbedSpy).toHaveBeenNthCalledWith(4, ["message embedding"], "passage");
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("does not reuse cached passage vectors for queries", async () => {
    setLocalEmbeddingsEnabled(true);
    localEmbedSpy
      .mockResolvedValueOnce([[0.25, 0.75]])
      .mockResolvedValueOnce([[0.75, 0.25]]);

    const passage = await embedBestEffort(["shared text"]);
    const query = await embedQuery(["shared text"]);

    expect(passage.vectors).toEqual([[0.25, 0.75]]);
    expect(query).toEqual([[0.75, 0.25]]);
    expect(localEmbedSpy).toHaveBeenNthCalledWith(1, ["shared text"], "passage");
    expect(localEmbedSpy).toHaveBeenNthCalledWith(2, ["shared text"], "query");
  });
});

describe("recall chat_archive", () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM memory_store").run();
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM threads").run();
    _resetEmbedCaches();
    embedSpy.mockReset();
    resolveEmbedClient = true;
  });

  // Pruned chat messages are copied to memory_store under the
  // chat_archive namespace (see pruneThreadMessages). recall() must
  // surface those rows as `source: "message"` so buildRecallContext
  // formats them as "past chat"/"earlier this thread" rather than
  // "[memory chat_archive/…]" — same user-facing shape as a live
  // message hit, so the model can't tell the row is archived.
  it("emits a chat_archive row as a message-source recall hit", async () => {
    const db = getDb();
    const vec = JSON.stringify([1, 0, 0, 0]);
    db.prepare(
      "INSERT INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,?)",
    ).run(
      "chat_archive",
      "user::thread-xyz::msg-abc",
      "archived user turn",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      vec,
    );

    // Query embedding = same vector so cosine ≈ 1 and the row ranks top.
    embedSpy.mockResolvedValueOnce([[1, 0, 0, 0]]);
    const hits = await recall("whatever query", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      source: "message",
      thread_id: "thread-xyz",
      role: "user",
      content: "archived user turn",
    });
  });

  it("still emits a non-chat_archive memory row as a memory-source hit", async () => {
    const db = getDb();
    const vec = JSON.stringify([1, 0, 0, 0]);
    db.prepare(
      "INSERT INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,?)",
    ).run(
      "facts",
      "fav_color",
      "orange",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      vec,
    );
    embedSpy.mockResolvedValueOnce([[1, 0, 0, 0]]);
    const hits = await recall("whatever query", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: "memory", namespace: "facts", key: "fav_color", content: "orange" });
  });

  it("falls back to a memory-source hit when a chat_archive key is malformed", async () => {
    const db = getDb();
    const vec = JSON.stringify([1, 0, 0, 0]);
    // Key missing the role::thread_id::msg_id triple separators — should
    // not break recall; the row surfaces as a plain memory hit.
    db.prepare(
      "INSERT INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,?)",
    ).run(
      "chat_archive",
      "legacy-garbage-key",
      "legacy content",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      vec,
    );
    embedSpy.mockResolvedValueOnce([[1, 0, 0, 0]]);
    const hits = await recall("whatever query", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("memory");
  });
});

describe("recall re-embeds vectors from a previous model", () => {
  async function seedMemory(key: string, vector: number[]) {
    const { getDb } = await import("@/lib/db");
    const t = new Date().toISOString();
    getDb().prepare("INSERT OR REPLACE INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,?)")
      .run("facts", key, JSON.stringify("the capital of France is Paris"), t, t, JSON.stringify(vector));
    return () => {
      const row = getDb().prepare("SELECT embedding FROM memory_store WHERE namespace=? AND key=?").get("facts", key) as { embedding: string };
      return JSON.parse(row.embedding) as number[];
    };
  }

  beforeEach(async () => {
    const { _resetEmbedCaches, _resetReembedState } = await import("./index");
    _resetEmbedCaches();
    _resetReembedState();
  });

  it("rewrites a stale-dimension memory vector with the active model", async () => {
    const { recall } = await import("./index");
    const read = await seedMemory("stale-dim", [1, 0]);
    setLocalEmbeddingsEnabled(true);
    localEmbedSpy.mockImplementation(async (texts: string[]) => texts.map(() => [0.5, 0.5, 0.5]));

    await recall("capital of France");

    await vi.waitFor(() => expect(read()).toHaveLength(3), { timeout: 5_000 });
  });

  it("detects a model swap even when the vector dimension is unchanged", async () => {
    const { reembedStaleVectors } = await import("./index");
    const { getEmbeddingVectorsSignature, setEmbeddingVectorsSignature } = await import("@/lib/stores/app-settings");
    const read = await seedMemory("same-dim", [1, 0, 0]);
    setEmbeddingVectorsSignature("openai:text-embedding-3-small");
    setLocalEmbeddingsEnabled(true);
    localEmbedSpy.mockImplementation(async (texts: string[]) => texts.map(() => [0.5, 0.5, 0.5]));

    await reembedStaleVectors();

    expect(read()).toEqual([0.5, 0.5, 0.5]);
    expect(getEmbeddingVectorsSignature()).toBe("Xenova/multilingual-e5-small");
  });

  it("pauses after a failure instead of retrying on every recall", async () => {
    const { reembedStaleVectors, getReembedStatus } = await import("./index");
    const { setEmbeddingVectorsSignature } = await import("@/lib/stores/app-settings");
    await seedMemory("fails", [1, 0, 0]);
    setEmbeddingVectorsSignature("openai:text-embedding-3-small");
    setLocalEmbeddingsEnabled(true);
    localEmbedSpy.mockRejectedValue(new Error("model offline"));

    await reembedStaleVectors();
    expect(getReembedStatus().error).toContain("unavailable");
    const calls = localEmbedSpy.mock.calls.length;

    await reembedStaleVectors();
    expect(localEmbedSpy.mock.calls.length).toBe(calls);
  });
});

describe("searchMemory", () => {
  function seed(namespace: string, key: string, value: string, vector: number[] | null) {
    const t = new Date().toISOString();
    getDb().prepare("INSERT OR REPLACE INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,?)")
      .run(namespace, key, value, t, t, vector ? JSON.stringify(vector) : null);
  }
  const storedVector = (namespace: string, key: string) => {
    const row = getDb().prepare("SELECT embedding FROM memory_store WHERE namespace=? AND key=?").get(namespace, key) as { embedding: string | null };
    return row.embedding ? (JSON.parse(row.embedding) as number[]) : null;
  };

  beforeEach(async () => {
    const { _resetEmbedCaches, _resetReembedState } = await import("./index");
    getDb().prepare("DELETE FROM memory_store").run();
    getDb().prepare("DELETE FROM messages").run();
    _resetEmbedCaches();
    _resetReembedState();
  });

  it("uses the calibrated chat floor only with bundled local embeddings", async () => {
    const { getDefaultChatMinSimilarity } = await import("./index");
    expect(getDefaultChatMinSimilarity()).toBe(0.25);

    setLocalEmbeddingsEnabled(true);
    expect(getDefaultChatMinSimilarity()).toBe(0.84);
  });

  it("restricts hits by source and namespace", async () => {
    const { searchMemory } = await import("./index");
    seed("facts", "color", "orange", [1, 0, 0, 0]);
    seed("chat_archive", "user::thread-1::msg-1", "archived turn", [1, 0, 0, 0]);
    embedSpy.mockResolvedValue([[1, 0, 0, 0]]);

    expect((await searchMemory("q", { sources: "memory" })).map((h) => h.source)).toEqual(["memory"]);
    expect((await searchMemory("q", { sources: "messages" })).map((h) => h.source)).toEqual(["message"]);
    const inNamespace = await searchMemory("q", { namespace: "facts" });
    expect(inNamespace.map((h) => h.key)).toEqual(["color"]);
  });

  it("finds exact text that similarity misses, only when asked", async () => {
    const { searchMemory } = await import("./index");
    seed("facts", "ticket", "Invoice ERR-4711 failed", [0, 1, 0, 0]);
    embedSpy.mockResolvedValue([[1, 0, 0, 0]]);

    expect(await searchMemory("ERR-4711", { sources: "memory" })).toEqual([]);
    const hits = await searchMemory("ERR-4711", { sources: "memory", literal: true });
    expect(hits.map((h) => h.key)).toEqual(["ticket"]);
    expect(hits[0].score).toBeCloseTo(0.9);
  });

  it("allows a lower semantic floor without filtering literal fallbacks", async () => {
    const { searchMemory } = await import("./index");
    seed("facts", "needle", "the needle is recorded", [0.2, Math.sqrt(0.96), 0, 0]);
    embedSpy.mockResolvedValue([[1, 0, 0, 0]]);

    expect(await searchMemory("needle", { sources: "memory" })).toEqual([]);
    const widened = await searchMemory("needle", { sources: "memory", minSimilarity: 0.1 });
    expect(widened.map((hit) => hit.key)).toEqual(["needle"]);
    expect(widened[0].match).toBe("semantic");

    const literal = await searchMemory("needle", { sources: "memory", minSimilarity: 0.99, literal: true });
    expect(literal.map((hit) => hit.key)).toEqual(["needle"]);
    expect(literal[0].match).toBe("literal");
  });

  it("uses an independent threshold for chat-history matches", async () => {
    const { searchMemory } = await import("./index");
    const t = new Date().toISOString();
    getDb().prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at,metadata,embedding) VALUES (?,?,?,?,?,?,?)")
      .run("threshold-chat", "thread-1", "user", "a related chat passage", t, null, JSON.stringify([0.2, Math.sqrt(0.96), 0, 0]));
    embedSpy.mockResolvedValue([[1, 0, 0, 0]]);

    expect(await searchMemory("query", { sources: "messages", minMessageSimilarity: 0.84 })).toEqual([]);
    const widened = await searchMemory("query", { sources: "messages", minMessageSimilarity: 0.1 });
    expect(widened.map((hit) => hit.thread_id)).toEqual(["thread-1"]);
  });

  it("embeds rows that never had a vector but leaves internal settings alone", async () => {
    const { reembedStaleVectors } = await import("./index");
    seed("facts", "never", "remember the milk", null);
    seed("app-settings", "some_setting", "\"x\"", null);
    setLocalEmbeddingsEnabled(true);
    localEmbedSpy.mockImplementation(async (texts: string[]) => texts.map(() => [0.5, 0.5, 0.5]));

    await reembedStaleVectors();

    expect(storedVector("facts", "never")).toEqual([0.5, 0.5, 0.5]);
    expect(storedVector("app-settings", "some_setting")).toBeNull();
  });

  it("embeds chat messages that never had a vector, skipping short and automation rows", async () => {
    const { reembedStaleVectors } = await import("./index");
    const t = new Date().toISOString();
    const insert = getDb().prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at,metadata) VALUES (?,?,?,?,?,?)");
    insert.run("m-long", "thread-1", "user", "what did we decide about billing retries", t, null);
    insert.run("m-short", "thread-1", "user", "ok", t, null);
    insert.run("m-auto", "thread-1", "assistant", "scheduled run output that is long enough", t, JSON.stringify({ automation_activity: true }));
    setLocalEmbeddingsEnabled(true);
    localEmbedSpy.mockImplementation(async (texts: string[]) => texts.map(() => [0.5, 0.5, 0.5]));

    await reembedStaleVectors();

    const state = (id: string) => (getDb().prepare("SELECT embedding FROM messages WHERE msg_id=?").get(id) as { embedding: string | null }).embedding;
    expect(state("m-long")).not.toBeNull();
    expect(state("m-short")).toBeNull();
    expect(state("m-auto")).toBeNull();
  });
});
