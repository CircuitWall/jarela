import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-memory-maintenance-"));
process.env.JARELA_DB_DIR = tmpRoot;

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* SQLite may hold the file */ }
});

const { getDb } = await import("@/lib/db");
const { getMemory, putMemory } = await import("@/lib/stores/memory");
const {
  MEMORY_APPLY_MAX_OPERATIONS, applyMemoryMaintenance, auditMemory, classifyMemoryValue, memoryFingerprint,
} = await import("./maintenance");

const NOW = "2026-10-29T00:00:00.000Z";

function insertRaw(namespace: string, key: string, value: string, updatedAt = NOW) {
  getDb()
    .prepare("INSERT INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)")
    .run(namespace, key, value, updatedAt, updatedAt);
}

function recordJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2, kind: "fact", subject: "Project", content: "Use deterministic checks.",
    tags: [], confidence: "explicit", source: "conversation", observed_at: null, expires_at: null,
    summary: null, aliases: [], status: "active", history: [], ...overrides,
  });
}

function structured(namespace: string, key: string, overrides: Record<string, unknown> = {}, updatedAt = NOW) {
  insertRaw(namespace, key, recordJson(overrides), updatedAt);
}

function fingerprintOf(namespace: string, key: string): string {
  const row = getDb().prepare("SELECT value, updated_at FROM memory_store WHERE namespace=? AND key=?")
    .get(namespace, key) as { value: string; updated_at: string };
  return memoryFingerprint(row.updated_at, row.value);
}

function storeRecord(namespace: string, key: string, overrides: Record<string, unknown> = {}) {
  return putMemory(namespace, key, {
    version: 2, kind: "fact", subject: "Project", content: "Use deterministic checks.",
    tags: [], confidence: "explicit", source: "conversation", observed_at: null, expires_at: null,
    summary: null, aliases: [], status: "active", ...overrides,
  });
}

beforeEach(() => {
  getDb().exec("DELETE FROM memory_store");
});

describe("memory classification", () => {
  it("separates structured records from legacy values and broken structured values", () => {
    expect(classifyMemoryValue(recordJson())).toMatchObject({ status: "structured" });
    expect(classifyMemoryValue(JSON.stringify("plain note"))).toEqual({ status: "unstructured" });
    expect(classifyMemoryValue(JSON.stringify({ version: 1 }))).toEqual({ status: "invalid" });
    expect(classifyMemoryValue("not json at all")).toEqual({ status: "unstructured" });
  });
});

describe("memory_audit", () => {
  it("groups every finding deterministically without touching protected namespaces", () => {
    structured("facts", "expired", { expires_at: "2026-10-01T00:00:00.000Z" });
    structured("facts", "dup-a");
    structured("facts", "dup-b");
    structured("facts", "near-a", { content: "Use deterministic checks for every build." });
    structured("facts", "near-b", { content: "Use deterministic checks for every build step." });
    structured("facts", "different-case", { content: "use deterministic checks." });
    structured("facts", "archived", { status: "archived" });
    insertRaw("facts", "legacy", JSON.stringify("plain note"));
    insertRaw("facts", "broken", JSON.stringify({ version: 1 }));
    insertRaw("chat_archive", "user::thread-1::msg-1", "unrelated transcript");
    insertRaw("app-settings", "theme", JSON.stringify("dark"));
    insertRaw("sessions", "agent/1", JSON.stringify({ summary: "compacted recap" }));
    insertRaw("app-lifecycle", "version_adoption_state", JSON.stringify({ checklist: [] }));

    const result = auditMemory({ now: NOW });

    expect(result.ok).toBe(true);
    expect(result.contract_version).toBe(1);
    expect(result.scan.scanned_records).toBe(9);
    expect(result.scan.archived_records).toBe(1);
    expect(result.scan.excluded_rows).toBe(4);
    expect(result.scan.truncated).toBe(false);
    expect(result.findings.expired).toEqual({ records: 1, groups: 1 });
    // Exact duplication normalizes case and whitespace, so the lower-case copy
    // belongs to the same group; genuinely different wording is near-duplicate.
    expect(result.findings.exact_duplicate).toEqual({ records: 3, groups: 1 });
    expect(result.findings.near_duplicate).toEqual({ records: 2, groups: 1 });
    expect(result.findings.unstructured.records).toBe(1);
    expect(result.findings.invalid.records).toBe(1);
    expect(result.findings.unembedded.records).toBe(0);

    const duplicateGroup = result.groups.find((group) => group.finding === "exact_duplicate")!;
    expect(duplicateGroup.records.map((entry) => entry.key).sort()).toEqual(["different-case", "dup-a", "dup-b"]);
    const nearGroup = result.groups.find((group) => group.finding === "near_duplicate")!;
    expect(nearGroup.records.map((entry) => entry.key).sort()).toEqual(["near-a", "near-b"]);
    // Exact duplicates are reported once, under exact_duplicate only.
    expect(result.groups.filter((group) => group.finding === "near_duplicate")).toHaveLength(1);

    expect(result.groups.every((group) => group.records.every((entry) => entry.namespace !== "chat_archive"))).toBe(true);
    expect(result.groups.every((group) => group.records.every((entry) => entry.namespace !== "app-settings"))).toBe(true);
    expect(result.groups.every((group) => group.records.every((entry) => entry.namespace !== "sessions"))).toBe(true);
    expect(result.groups.every((group) => group.records.every((entry) => entry.namespace !== "app-lifecycle"))).toBe(true);
    expect(auditMemory({ now: NOW })).toEqual(result);
  });

  it("pages groups by cursor so a large store is reviewed in bounded pages", () => {
    for (let index = 0; index < 7; index++) {
      insertRaw("facts", `note-${index}`, JSON.stringify(`plain note ${index}`));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = auditMemory({ now: NOW, maxGroups: 3, cursor });
      expect(page.groups.length).toBeLessThanOrEqual(3);
      seen.push(...page.groups.map((group) => group.group_id));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(pages).toBe(3);
    expect(() => auditMemory({ now: NOW, cursor: "garbage" })).toThrow("cursor_invalid");
  });

  it("scans past the first keyset batch", () => {
    const insert = getDb().prepare("INSERT INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)");
    getDb().exec("BEGIN");
    for (let index = 0; index < 1200; index++) {
      insert.run("facts", `note-${String(index).padStart(5, "0")}`, JSON.stringify(`plain note ${index}`), NOW, NOW);
    }
    getDb().exec("COMMIT");

    const result = auditMemory({ now: NOW, batchSize: 50, findings: ["unstructured"], maxGroups: 5 });
    expect(result.scan.scanned_records).toBe(1200);
    expect(result.findings.unstructured.records).toBe(1200);
    expect(result.groups).toHaveLength(5);
    expect(result.next_cursor).not.toBeNull();
  });

  it("reports records that never received an embedding once the grace window passed", () => {
    structured("facts", "recent");
    structured("facts", "stale-embed", {}, "2026-10-20T00:00:00.000Z");
    const result = auditMemory({ now: NOW });
    expect(result.findings.unembedded).toMatchObject({ records: 1, groups: 1 });
    expect(result.groups.find((group) => group.finding === "unembedded")!.records[0].key).toBe("stale-embed");
  });

  it("refuses to audit a namespace another subsystem owns", () => {
    expect(() => auditMemory({ now: NOW, namespace: "chat_archive" })).toThrow("namespace_excluded");
    expect(() => auditMemory({ now: NOW, namespace: "tool-secrets" })).toThrow("namespace_excluded");
  });
});

describe("memory_apply_maintenance", () => {
  it("defaults to a dry run that reports the plan without writing", () => {
    storeRecord("facts", "dup-a");
    storeRecord("facts", "dup-b");
    const fingerprint = fingerprintOf("facts", "dup-a");

    const preview = applyMemoryMaintenance({
      now: NOW, dryRun: true,
      operations: [
        { action: "archive", namespace: "facts", key: "dup-a", expected_fingerprint: fingerprint },
        { action: "archive_duplicates" },
      ],
    });

    expect(preview).toMatchObject({ ok: true, dry_run: true, applied: 0, planned: 2 });
    expect(JSON.parse(getMemory("facts", "dup-a")!.value).status).toBe("active");
  });

  it("rejects a record that changed after the audit instead of overwriting it", () => {
    storeRecord("facts", "policy", { content: "Original content." });
    const stale = fingerprintOf("facts", "policy");
    storeRecord("facts", "policy", { content: "Changed after the audit." });

    const result = applyMemoryMaintenance({
      now: NOW, dryRun: false,
      operations: [{ action: "archive", namespace: "facts", key: "policy", expected_fingerprint: stale }],
    });

    expect(result.outcomes[0]).toMatchObject({ status: "stale", reason: "record_changed_since_audit" });
    expect(JSON.parse(getMemory("facts", "policy")!.value)).toMatchObject({
      status: "active", content: "Changed after the audit.",
    });
  });

  it("archives with history, deletes only on request, and converts a legacy value in place", () => {
    storeRecord("facts", "keep-history", { content: "First wording." });
    storeRecord("facts", "keep-history", { content: "Second wording." });
    insertRaw("facts", "legacy-note", JSON.stringify("plain note"));
    storeRecord("facts", "removable");

    const result = applyMemoryMaintenance({
      now: NOW, dryRun: false,
      operations: [
        { action: "archive", namespace: "facts", key: "keep-history", expected_fingerprint: fingerprintOf("facts", "keep-history") },
        { action: "delete", namespace: "facts", key: "removable", expected_fingerprint: fingerprintOf("facts", "removable") },
        {
          action: "upsert", namespace: "facts", key: "legacy-note",
          expected_fingerprint: fingerprintOf("facts", "legacy-note"),
          record: {
            kind: "fact", subject: "Legacy note", content: "plain note", tags: ["migrated"],
            confidence: "inferred", source: "import", observed_at: null, expires_at: null,
            summary: null, aliases: [], status: "active",
          },
        },
      ],
    });

    expect(result).toMatchObject({ ok: true, applied: 3, stale: 0, failed: 0 });
    const archived = JSON.parse(getMemory("facts", "keep-history")!.value);
    expect(archived.status).toBe("archived");
    expect(archived.history).toHaveLength(2);
    expect(archived.history[0].record.content).toBe("First wording.");
    expect(getMemory("facts", "removable")).toBeNull();
    expect(JSON.parse(getMemory("facts", "legacy-note")!.value)).toMatchObject({
      version: 2, kind: "fact", subject: "Legacy note", content: "plain note", tags: ["migrated"],
    });
  });

  it("enforces the canonical key rule in facts and requires opt-in for other namespaces", () => {
    insertRaw("facts", "spaced key", JSON.stringify("plain note"));
    insertRaw("notes", "spaced key", JSON.stringify("plain note"));
    const record = {
      kind: "fact", subject: "Note", content: "plain note", tags: [], confidence: "inferred" as const,
      source: "import" as const, observed_at: null, expires_at: null, summary: null, aliases: [], status: "active" as const,
    };
    const notesOperation = {
      action: "upsert" as const, namespace: "notes", key: "spaced key",
      expected_fingerprint: fingerprintOf("notes", "spaced key"), record,
    };

    const result = applyMemoryMaintenance({
      now: NOW, dryRun: true,
      operations: [
        { action: "upsert", namespace: "facts", key: "spaced key", expected_fingerprint: fingerprintOf("facts", "spaced key"), record },
        notesOperation,
      ],
    });

    expect(result.outcomes[0]).toMatchObject({ status: "failed", reason: "key_not_canonical" });
    expect(result.outcomes[1]).toMatchObject({ status: "failed", reason: "namespace_requires_opt_in" });

    const optedIn = applyMemoryMaintenance({
      now: NOW, dryRun: true, allowNonFactsNamespaces: true, operations: [notesOperation],
    });
    expect(optedIn.outcomes[0]).toMatchObject({ status: "planned" });
  });

  it("keeps bulk archival inside facts unless the caller opts in", () => {
    storeRecord("facts", "expired-facts", { expires_at: "2026-10-01T00:00:00.000Z" });
    insertRaw("notes", "expired-notes", recordJson({ expires_at: "2026-10-01T00:00:00.000Z" }));

    const result = applyMemoryMaintenance({
      now: NOW, dryRun: false, operations: [{ action: "archive_expired" }],
    });

    expect(result.outcomes[0]).toMatchObject({ status: "applied", affected: 1, matched: 1 });
    expect(JSON.parse(getMemory("facts", "expired-facts")!.value).status).toBe("archived");
    expect(JSON.parse(getMemory("notes", "expired-notes")!.value).status).toBe("active");
  });

  it("archives every expired record in code and reports the remaining backlog", () => {
    for (let index = 0; index < 5; index++) {
      storeRecord("facts", `expired-${index}`, { expires_at: "2026-10-01T00:00:00.000Z" });
    }
    storeRecord("facts", "active-record");

    const preview = applyMemoryMaintenance({
      now: NOW, dryRun: true, operations: [{ action: "archive_expired", limit: 2 }],
    });
    expect(preview.outcomes[0]).toMatchObject({ status: "planned", affected: 2, matched: 5, reason: "bulk_limit_reached" });
    expect(JSON.parse(getMemory("facts", "expired-0")!.value).status).toBe("active");

    const applied = applyMemoryMaintenance({
      now: NOW, dryRun: false, operations: [{ action: "archive_expired" }],
    });
    expect(applied.outcomes[0]).toMatchObject({ status: "applied", affected: 5, matched: 5 });
    const statuses = getDb().prepare("SELECT value FROM memory_store WHERE namespace='facts'").all()
      .map((row) => JSON.parse(String((row as { value: string }).value)).status);
    expect(statuses.filter((status) => status === "archived")).toHaveLength(5);
    expect(JSON.parse(getMemory("facts", "active-record")!.value).status).toBe("active");
  });

  it("keeps the strongest-provenance survivor when archiving exact duplicates", () => {
    storeRecord("facts", "inferred-copy", { confidence: "inferred" });
    storeRecord("facts", "verified-copy", { confidence: "verified" });
    storeRecord("facts", "explicit-copy", { confidence: "explicit" });

    const result = applyMemoryMaintenance({
      now: NOW, dryRun: false, operations: [{ action: "archive_duplicates" }],
    });

    expect(result.outcomes[0]).toMatchObject({ status: "applied", affected: 2, matched: 2 });
    expect(JSON.parse(getMemory("facts", "verified-copy")!.value).status).toBe("active");
    expect(JSON.parse(getMemory("facts", "inferred-copy")!.value).status).toBe("archived");
    expect(JSON.parse(getMemory("facts", "explicit-copy")!.value).status).toBe("archived");
  });

  it("rejects excluded namespaces, invalid records and oversized batches", () => {
    insertRaw("chat_archive", "user::thread-1::msg-1", "transcript");
    const result = applyMemoryMaintenance({
      now: NOW, dryRun: true,
      operations: [
        {
          action: "upsert", namespace: "chat_archive", key: "user::thread-1::msg-1", expected_fingerprint: null,
          record: { kind: "fact", subject: "x", content: "y", tags: [], confidence: "inferred", source: "import" },
        },
        {
          action: "upsert", namespace: "facts", key: "bad-record", expected_fingerprint: null,
          record: { kind: "fact" },
        },
      ],
    });
    expect(result.outcomes[0]).toMatchObject({ status: "failed", reason: "namespace_excluded" });
    expect(result.outcomes[1].status).toBe("failed");
    expect(result.outcomes[1].reason).toMatch(/^invalid_record/);
    expect(() => applyMemoryMaintenance({
      now: NOW, dryRun: true,
      operations: Array.from({ length: MEMORY_APPLY_MAX_OPERATIONS + 1 }, () => ({ action: "archive_expired" as const })),
    })).toThrow("too_many_operations");
  });
});
