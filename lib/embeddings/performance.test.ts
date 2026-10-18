import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { afterAll, expect, it, vi } from "vitest";
import { LOCAL_EMBEDDING_MODEL_ID } from "./constants";

// Opt-in, local-only benchmark. No user database, credentials, or downloads.
const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }));
vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!state.db) throw new Error("benchmark database not initialized");
    return state.db;
  },
}));
vi.mock("@/lib/providers", () => ({
  getProvider: () => { throw new Error("remote providers are forbidden in this benchmark"); },
}));
vi.mock("@/lib/stores/model-config", () => ({
  getModelConfig: () => null,
  getDefaultModelConfig: () => null,
  getModelParams: () => ({}),
  listModelConfigs: () => [],
}));

const previousDownload = process.env.JARELA_LOCAL_EMBEDDING_DOWNLOAD;
afterAll(() => {
  state.db?.close();
  if (previousDownload === undefined) delete process.env.JARELA_LOCAL_EMBEDDING_DOWNLOAD;
  else process.env.JARELA_LOCAL_EMBEDDING_DOWNLOAD = previousDownload;
});

it.skipIf(process.env.JARELA_BENCHMARK_EMBEDDINGS !== "1")(
  "reports local embedding and synthetic memory-search latency",
  async () => {
    process.env.JARELA_LOCAL_EMBEDDING_DOWNLOAD = "0";
    const { getLocalModelStatus } = await import("./local-model");
    expect(getLocalModelStatus().state, "Install the local model before running this offline benchmark").toBe("ready");
    const { runMigrations } = await import("@/lib/db/migrations");
    state.db = new DatabaseSync(":memory:");
    runMigrations(state.db);
    const { setLocalEmbeddingsEnabled, setEmbeddingVectorsSignature } = await import("@/lib/stores/app-settings");
    setLocalEmbeddingsEnabled(true);
    setEmbeddingVectorsSignature(LOCAL_EMBEDDING_MODEL_ID);
    const { embedLocally } = await import("./local");
    const { embedQueryOne, searchMemory, _resetEmbeddingCache, _resetEmbedCaches, reembedStaleVectors } = await import("./index");
    const results: Array<{ operation: string; samples: number; median_ms: number; p95_ms: number }> = [];
    async function time(operation: string, count: number, run: (index: number) => Promise<void>) {
      const elapsed: number[] = [];
      for (let i = 0; i < count; i++) {
        const start = performance.now();
        await run(i);
        elapsed.push(performance.now() - start);
      }
      elapsed.sort((a, b) => a - b);
      results.push({
        operation, samples: count,
        median_ms: Number(elapsed[Math.floor(elapsed.length / 2)].toFixed(3)),
        p95_ms: Number(elapsed[Math.ceil(elapsed.length * 0.95) - 1].toFixed(3)),
      });
    }
    const query = "What is the deployment rollback procedure?";
    const validate = (vector: number[] | null) => {
      expect(vector).toHaveLength(384);
      expect(vector?.every(Number.isFinite)).toBe(true);
    };
    await time("cold pipeline + first query inference", 1, async () => {
      validate((await embedLocally([query], "query"))[0]);
    });
    await time("warm pipeline, uncached short query", 10, async (i) => {
      validate((await embedLocally([`${query} revision ${i}`], "query"))[0]);
    });
    await time("warm pipeline, 16 short passages", 3, async () => {
      const vectors = await embedLocally(Array.from({ length: 16 }, (_, i) => `Deployment step ${i}: preserve backups and verify health.`), "passage");
      expect(vectors).toHaveLength(16);
      vectors.forEach(validate);
    });
    await embedQueryOne(query);
    await time("query embedding content-cache hit", 20, async () => { validate(await embedQueryOne(query)); });
    const vector = await embedQueryOne(query);
    const encoded = JSON.stringify(vector);
    const db = state.db;
    db.prepare("INSERT INTO threads(thread_id,agent_id,created_at,updated_at) VALUES ('bench','bench',?,?)")
      .run("2026-01-01", "2026-01-01");
    const memory = db.prepare("INSERT INTO memory_store(namespace,key,value,created_at,updated_at,embedding) VALUES ('benchmark',?,?,?,?,?)");
    const message = db.prepare("INSERT INTO messages(msg_id,thread_id,role,content,created_at,embedding) VALUES (?,'bench','assistant',?,?,?)");
    const job = db.prepare("INSERT INTO message_embedding_jobs(message_id,source_hash,state,created_at,updated_at,model_signature) VALUES (?,?,'done','2026-01-01','2026-01-01',?)");
    for (const rows of [1_000, 10_000]) {
      db.exec("DELETE FROM memory_store WHERE namespace='benchmark'; DELETE FROM message_embedding_jobs; DELETE FROM messages; BEGIN");
      for (let i = 0; i < rows / 2; i++) {
        const content = `Synthetic deployment rollback procedure ${i}: restore backup, verify health, then resume traffic.`;
        memory.run(`key-${i}`, content, "2026-01-01", "2026-01-01", encoded);
        message.run(`msg-${i}`, content, "2026-01-01", encoded);
        job.run(`msg-${i}`, "synthetic", LOCAL_EMBEDDING_MODEL_ID);
      }
      db.exec("COMMIT");
      _resetEmbedCaches();
      await time(`${rows} vectors: first search, cold row cache`, 1, async () => {
        const hits = await searchMemory(query, { literal: true, limit: 10 });
        expect(hits).toHaveLength(10);
      });
      await reembedStaleVectors(384);
      await time(`${rows} vectors: warm rows + cached query`, 10, async () => {
        expect(await searchMemory(query, { literal: true, limit: 10 })).toHaveLength(10);
      });
      await time(`${rows} vectors: warm rows + new query inference`, 5, async (i) => {
        _resetEmbeddingCache();
        expect(await searchMemory(`${query} check ${i}`, { literal: true, limit: 10 })).toHaveLength(10);
      });
      await reembedStaleVectors(384);
    }
    console.table(results);
    console.log("Synthetic repeated 384-dimensional vectors; measures scan/sort cost, not retrieval quality. No HTTP transport or provider network latency.");
  },
  120_000,
);
