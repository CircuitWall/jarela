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

const { memoryReadTool, memoryWriteTool, memoryDeleteTool, memoryListTool } =
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
  });
});
