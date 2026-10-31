import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { encrypt } from "@/lib/crypto/envelope";
import { getMemory, putMemory } from "./memory";

vi.mock("@/lib/embeddings", () => ({
  embedOne: vi.fn().mockResolvedValue(null),
  upsertMemoryEmbedCache: vi.fn(),
  evictMemoryEmbedCache: vi.fn(),
}));

beforeEach(() => getDb().exec("DELETE FROM memory_store"));
afterAll(() => closeDb());

function record(content: string) {
  return {
    version: 2, kind: "fact", subject: "Synthetic revision",
    content, tags: [], confidence: "verified", source: "import",
  };
}

it.each(["facts", "tool-secrets"])("preserves bounded flat revision history in %s", (namespace) => {
  const initial = putMemory(namespace, "synthetic-history", record("Synthetic initial"));
  for (let index = 1; index <= 22; index++) {
    putMemory(namespace, initial.key, record(`Synthetic revision ${index}`));
  }
  const row = getMemory(namespace, initial.key)!;
  const stored = JSON.parse(row.value);
  expect(row.created_at).toBe(initial.created_at);
  expect(stored.content).toBe("Synthetic revision 22");
  expect(stored.history).toHaveLength(20);
  expect(stored.history[0].record.content).toBe("Synthetic revision 2");
  expect(stored.history.at(-1).record.content).toBe("Synthetic revision 21");
  expect(stored.history.every((entry: { record: object }) => !("history" in entry.record))).toBe(true);
  if (namespace === "tool-secrets") {
    const raw = getDb().prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?").get(namespace, initial.key)?.value;
    expect(raw).toMatch(/^enc:v1:/);
    expect(raw).not.toContain("Synthetic revision");
  }
});

it("retains an encrypted legacy v1 record as the first snapshot on update", () => {
  const previous = { ...record("Synthetic legacy"), version: 1 };
  getDb().prepare(`INSERT INTO memory_store(namespace,key,value,created_at,updated_at)
    VALUES ('tool-secrets','synthetic-legacy',?,'2026-10-30T00:00:00.000Z','2026-10-30T00:00:00.000Z')`)
    .run(encrypt(JSON.stringify(previous)));
  const row = putMemory("tool-secrets", "synthetic-legacy", record("Synthetic current"));
  expect(JSON.parse(row.value).history).toEqual([{
    updated_at: row.updated_at,
    record: expect.objectContaining({ version: 2, content: "Synthetic legacy" }),
  }]);
});

it("does not overwrite a corrupt encrypted previous value", () => {
  const corrupt = "enc:v1:synthetic-corrupt-envelope";
  getDb().prepare(`INSERT INTO memory_store(namespace,key,value,created_at,updated_at)
    VALUES ('tool-secrets','synthetic-corrupt',?,'2026-10-30T00:00:00.000Z','2026-10-30T00:00:00.000Z')`).run(corrupt);
  expect(() => putMemory("tool-secrets", "synthetic-corrupt", record("Synthetic replacement"))).toThrow();
  expect(getDb().prepare("SELECT value FROM memory_store WHERE key='synthetic-corrupt'").get()?.value).toBe(corrupt);
});
