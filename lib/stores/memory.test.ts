import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { embedOne, searchMemory, upsertMemoryEmbedCache } from "@/lib/embeddings";
import { encrypt } from "@/lib/crypto/envelope";
import { SKILL_EXECUTION_POLICY_KEY } from "@/lib/skills/execution-policy";
import { deleteMemory, getMemory, listMemory, putMemory, searchMemoryRows } from "./memory";

vi.mock("@/lib/embeddings", () => ({
  embedOne: vi.fn().mockResolvedValue(null),
  searchMemory: vi.fn().mockResolvedValue([]),
  upsertMemoryEmbedCache: vi.fn(),
  evictMemoryEmbedCache: vi.fn(),
}));

beforeEach(() => {
  getDb().exec("DELETE FROM memory_store");
  vi.mocked(embedOne).mockReset().mockResolvedValue(null);
  vi.mocked(searchMemory).mockReset().mockResolvedValue([]);
  vi.mocked(upsertMemoryEmbedCache).mockClear();
});
afterAll(() => closeDb());

function legacy(namespace: string, key: string, value: string) {
  getDb().prepare(`INSERT INTO memory_store(namespace,key,value,created_at,updated_at)
    VALUES (?,?,?,'2026-10-30T00:00:00.000Z','2026-10-30T00:00:00.000Z')`).run(namespace, key, value);
}

it("decrypts sensitive values for reads and lists without exposing ciphertext to callers", () => {
  const row = putMemory("tool-secrets", "synthetic", { value: "synthetic-only" });
  const stored = getDb().prepare("SELECT value FROM memory_store WHERE key='synthetic'").get();
  expect(stored?.value).toMatch(/^enc:v1:/);
  expect(getMemory(row.namespace, row.key)).toEqual(row);
  expect(listMemory("tool-secrets")).toEqual([row]);
  expect(listMemory()).toEqual([row]);
});

it("blocks derived advertisements and security-policy mutation through general memory", () => {
  expect(() => listMemory("agent-advertisements")).toThrow(/advertisement settings/);
  expect(() => getMemory("agent-advertisements", "synthetic")).toThrow(/advertisement settings/);
  for (const operation of [putMemory, deleteMemory]) {
    expect(() => operation("agent-advertisements", "synthetic", {})).toThrow(/advertisement settings/);
    expect(() => operation("app-settings", SKILL_EXECUTION_POLICY_KEY, {})).toThrow(/Security settings/);
  }
});

it("upgrades valid legacy records at read time and preserves malformed or plain values", () => {
  const record = JSON.stringify({
    version: 1, kind: "fact", subject: "Synthetic", content: "Synthetic fixture",
    tags: [], confidence: "verified", source: "import",
  });
  legacy("facts", "plain", "plain legacy text");
  legacy("facts", "invalid", JSON.stringify({ version: 1 }));
  legacy("facts", "valid", record);
  legacy("tool-secrets", "sensitive", encrypt(record));
  expect(getMemory("facts", "plain")?.value).toBe("plain legacy text");
  expect(getMemory("facts", "invalid")?.value).toBe(JSON.stringify({ version: 1 }));
  expect(JSON.parse(getMemory("facts", "valid")!.value)).toMatchObject({ version: 2, status: "active" });
  expect(JSON.parse(getMemory("tool-secrets", "sensitive")!.value)).toMatchObject({ version: 2 });
  expect(getDb().prepare("SELECT value FROM memory_store WHERE key='sensitive'").get()?.value).toMatch(/^enc:v1:/);
  expect(getMemory("facts", "missing")).toBeNull();
});

it("persists and caches a completed embedding without blocking the memory write", async () => {
  vi.mocked(embedOne).mockResolvedValue([0.25, 0.75]);
  const row = putMemory("facts", "synthetic-vector", "Synthetic content");
  await vi.waitFor(() => expect(upsertMemoryEmbedCache).toHaveBeenCalledWith(
    row.namespace, row.key, row.value, [0.25, 0.75], row.updated_at,
  ));
  expect(getDb().prepare("SELECT embedding FROM memory_store WHERE key=?").get(row.key)?.embedding).toBe("[0.25,0.75]");
});

it("deduplicates hybrid hits, skips invalid identities and obeys the result cap", async () => {
  const first = putMemory("facts", "synthetic-first", "matching");
  const second = putMemory("facts", "synthetic-second", "matching");
  vi.mocked(searchMemory).mockResolvedValue([
    { namespace: first.namespace, key: first.key },
    { namespace: first.namespace, key: first.key },
    { namespace: "facts", key: "missing" },
    { namespace: second.namespace, key: second.key },
    { namespace: "facts" },
  ].map((identity) => ({
    ...identity, source: "memory", content: "Synthetic match", score: 1,
    created_at: "2026-10-30T00:00:00.000Z",
  })));
  expect(await searchMemoryRows("facts", "matching", 1)).toEqual([first]);
  expect(await searchMemoryRows("facts", "matching", 2)).toEqual([first, second]);
  vi.mocked(searchMemory).mockRejectedValue(new Error("Synthetic embedding outage"));
  expect(await searchMemoryRows("facts", "matching", 2)).toHaveLength(2);
});
