import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-memory-maintenance-tool-"));
process.env.JARELA_DB_DIR = tmpRoot;

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* SQLite may hold the file */ }
});

const { memoryApplyMaintenanceTool, memoryAuditTool } = await import("./memory-maintenance");
const { getDb } = await import("@/lib/db");
const { getMemory, putMemory } = await import("@/lib/stores/memory");
const { memoryFingerprint } = await import("@/lib/memory/maintenance");
const { registeredCapability, registeredCategory } = await import("../runtime/registry");

const NOW = "2026-10-29T00:00:00.000Z";

function storeRecord(key: string, content = "Use deterministic checks.") {
  putMemory("facts", key, {
    version: 2, kind: "fact", subject: "Project", content,
    tags: [], confidence: "explicit", source: "conversation", observed_at: null, expires_at: null,
    summary: null, aliases: [], status: "active",
  });
}

function fingerprintOf(key: string): string {
  const row = getDb().prepare("SELECT value, updated_at FROM memory_store WHERE namespace='facts' AND key=?")
    .get(key) as { value: string; updated_at: string };
  return memoryFingerprint(row.updated_at, row.value);
}

beforeEach(() => {
  getDb().exec("DELETE FROM memory_store");
});

describe("memory maintenance tool surface", () => {
  it("registers the audit as a Memory read tool and the apply step as a Memory write tool", () => {
    expect(memoryAuditTool.name).toBe("memory_audit");
    expect(memoryApplyMaintenanceTool.name).toBe("memory_apply_maintenance");
    expect(registeredCategory("memory_audit")).toBe("Memory");
    expect(registeredCapability("memory_audit")).toBe("read");
    expect(registeredCategory("memory_apply_maintenance")).toBe("Memory");
    expect(registeredCapability("memory_apply_maintenance")).toBe("write");
  });

  it("keeps both schemas serializable for provider tool definitions", () => {
    expect(convertToOpenAITool(memoryAuditTool).function.name).toBe("memory_audit");
    expect(convertToOpenAITool(memoryApplyMaintenanceTool).function.name).toBe("memory_apply_maintenance");
  });
});

describe("memory_audit tool", () => {
  it("returns a bounded, code-computed page of duplicates", async () => {
    storeRecord("dup-a");
    storeRecord("dup-b");
    const result = JSON.parse(await memoryAuditTool.invoke({ now: NOW, namespace: "facts" }) as string);

    expect(result).toMatchObject({ ok: true, contract_version: 1, next_cursor: null });
    expect(result.findings.exact_duplicate).toEqual({ records: 2, groups: 1 });
    expect(result.groups[0].records[0].fingerprint).toMatch(/^[a-f0-9]{32}$/);
  });

  it("reports an excluded namespace as an error instead of reading it", async () => {
    const result = JSON.parse(await memoryAuditTool.invoke({ now: NOW, namespace: "chat_archive" }) as string);
    expect(result).toEqual({ ok: false, error: "namespace_excluded" });
  });
});

describe("memory_apply_maintenance tool", () => {
  it("defaults to a dry run that writes nothing", async () => {
    storeRecord("keep");
    const result = JSON.parse(await memoryApplyMaintenanceTool.invoke({
      now: NOW,
      operations: [{ action: "archive", namespace: "facts", key: "keep", expected_fingerprint: fingerprintOf("keep") }],
    }) as string);

    expect(result).toMatchObject({ ok: true, dry_run: true, planned: 1, applied: 0 });
    expect(JSON.parse(getMemory("facts", "keep")!.value).status).toBe("active");
  });

  it("applies an approved plan and reports the result", async () => {
    storeRecord("keep");
    const result = JSON.parse(await memoryApplyMaintenanceTool.invoke({
      now: NOW,
      dry_run: false,
      operations: [{ action: "archive", namespace: "facts", key: "keep", expected_fingerprint: fingerprintOf("keep") }],
    }) as string);

    expect(result).toMatchObject({ ok: true, dry_run: false, applied: 1 });
    expect(JSON.parse(getMemory("facts", "keep")!.value).status).toBe("archived");
  });

  it("rejects a malformed operation before touching the store", async () => {
    await expect(memoryApplyMaintenanceTool.invoke({
      now: NOW,
      operations: [{ action: "archive", namespace: "facts", key: "keep" }],
    } as never)).rejects.toThrow();
  });
});
