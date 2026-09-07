import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin JARELA_DB_DIR to a hermetic tmpdir so the SQLite store doesn't touch
// the user's real ~/.jarela database. Must be set BEFORE importing the
// store / tool — both resolve the DB path on first use.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-memory-"));
process.env.JARELA_DB_DIR = tmpRoot;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { memoryReadTool, memoryWriteTool, memoryUpsertTool, memoryDeleteTool, memoryListTool } =
  await import("./memory");
const { putMemory, getMemory, listMemory, deleteMemory } = await import("@/lib/stores/memory");

beforeEach(() => {
  // Clear rows between tests via the store API. We deliberately do NOT
  // rm the tmpdir here: SQLite holds open file handles to the .db and
  // on Windows that makes rmSync flaky with EPERM, which would block
  // the pre-commit hook for every contributor on Windows.
  for (const row of listMemory(undefined, undefined, 1000)) {
    deleteMemory(row.namespace, row.key);
  }
});

describe("memoryDeleteTool", () => {
  it("removes an existing entry and reports removed=true", async () => {
    putMemory("test", "k1", JSON.stringify("v1"));
    expect(getMemory("test", "k1")).not.toBeNull();

    const raw = await memoryDeleteTool.invoke({ namespace: "test", key: "k1" });
    const out = JSON.parse(raw as string);

    expect(out).toEqual({ ok: true, namespace: "test", key: "k1", removed: true });
    expect(getMemory("test", "k1")).toBeNull();
  });

  it("reports removed=false when no row existed", async () => {
    const raw = await memoryDeleteTool.invoke({ namespace: "ghost", key: "nope" });
    const out = JSON.parse(raw as string);
    expect(out).toEqual({ ok: true, namespace: "ghost", key: "nope", removed: false });
  });

  it("does not affect siblings in the same namespace", async () => {
    putMemory("ns", "a", JSON.stringify(1));
    putMemory("ns", "b", JSON.stringify(2));

    await memoryDeleteTool.invoke({ namespace: "ns", key: "a" });

    expect(getMemory("ns", "a")).toBeNull();
    expect(getMemory("ns", "b")).not.toBeNull();
  });

  it("is registered alongside read/write/list", () => {
    expect(memoryReadTool.name).toBe("memory_read");
    expect(memoryWriteTool.name).toBe("memory_write");
    expect(memoryListTool.name).toBe("memory_list");
    expect(memoryDeleteTool.name).toBe("memory_delete");
    expect(memoryUpsertTool.name).toBe("memory_upsert");
  });
});

describe("memoryUpsertTool", () => {
  it("stores a durable fact as a structured JSON record at the current schema version", async () => {
    const output = await memoryUpsertTool.invoke({
      namespace: "facts",
      key: "user-research-preference",
      record: {
        kind: "preference",
        subject: "User workflow",
        content: "Research platform behavior before iterative fixes.",
        tags: ["workflow", "research"],
        confidence: "explicit",
        source: "conversation",
        observed_at: "2026-09-07T00:00:00.000Z",
        expires_at: null,
      },
    });

    expect(JSON.parse(output as string)).toMatchObject({ ok: true, kind: "preference" });
    expect(JSON.parse(getMemory("facts", "user-research-preference")!.value)).toMatchObject({
      version: 2,
      subject: "User workflow",
      status: "active",
      aliases: [],
      summary: null,
    });
  });

  it("keeps a dated revision history for structured memory updates", async () => {
    const firstRecord = {
      kind: "fact" as const,
      subject: "Build policy",
      content: "Use the local default toolchain for this repo.",
      tags: ["build", "toolchain"],
      confidence: "explicit" as const,
      source: "conversation" as const,
      observed_at: "2026-09-07T00:00:00.000Z",
      expires_at: null,
    };

    await memoryUpsertTool.invoke({
      namespace: "facts",
      key: "build-policy",
      record: firstRecord,
    });

    const firstPersisted = JSON.parse(getMemory("facts", "build-policy")!.value);
    expect(firstPersisted.history).toEqual([]);

    await memoryUpsertTool.invoke({
      namespace: "facts",
      key: "build-policy",
      record: {
        ...firstRecord,
        content: "Use the local default toolchain for this repo, and prefer the repo's make task wrappers.",
        tags: ["build", "toolchain", "workflow"],
        observed_at: "2026-09-08T00:00:00.000Z",
      },
    });

    const updatedPersisted = JSON.parse(getMemory("facts", "build-policy")!.value);
    expect(updatedPersisted.history).toHaveLength(1);
    expect(updatedPersisted.history[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(updatedPersisted.history[0].record.content).toBe(firstRecord.content);
    expect(updatedPersisted.history[0].record).not.toHaveProperty("history");
    expect(updatedPersisted.content).toContain("prefer the repo's make task wrappers");
  });

  it("lazily upgrades a legacy v1 row and writes the migration back on read", async () => {
    putMemory("facts", "legacy-fact", {
      version: 1,
      kind: "fact",
      subject: "Legacy fact",
      content: "Stored before the v2 schema shipped.",
      tags: ["legacy"],
      confidence: "verified",
      source: "tool_result",
      observed_at: null,
      expires_at: null,
    });

    const migrated = JSON.parse(getMemory("facts", "legacy-fact")!.value);
    expect(migrated).toMatchObject({ version: 2, status: "active", aliases: [], summary: null });

    // Re-reading the raw row directly proves the upgrade was persisted,
    // not just returned in-memory by parseStructuredMemory.
    const rawRows = listMemory("facts", "legacy-fact", 1);
    expect(JSON.parse(rawRows[0].value).version).toBe(2);
  });

  it("rejects records without the required structured fields", async () => {
    await expect(memoryUpsertTool.invoke({
      namespace: "facts",
      key: "bad",
      record: { content: "missing required structure" },
    } as never)).rejects.toThrow();
  });
});
