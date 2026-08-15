import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test run — point JARELA_DB_DIR at a tmp dir BEFORE
// importing modules that open the DB.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-doc-remote-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  createDocumentSource,
  deleteDocumentSource,
  listDocumentSources,
  parseSourceConfig,
  updateDocumentSourceCursor,
  getDocumentSource,
} = await import("@/lib/stores/document-sources");

const { upsertRemoteDocument } = await import("./upsert");
const { searchDocuments } = await import("@/lib/documents/search");
const { getDb } = await import("@/lib/db");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("document_sources kind + config (ADR-0026)", () => {
  beforeEach(() => {
    for (const s of listDocumentSources()) deleteDocumentSource(s.id);
  });

  it("defaults kind to local_folder when not supplied", () => {
    const s = createDocumentSource({ path: "/tmp/some-folder", label: "x" });
    expect(s.kind).toBe("local_folder");
    expect(s.config).toBeNull();
  });

  it("persists kind and JSON-encoded config for remote sources", () => {
    const s = createDocumentSource({
      path: "confluence-space://ENG",
      label: "Eng wiki",
      kind: "confluence_space",
      config: { space_key: "ENG", recency_days: 90 },
    });
    expect(s.kind).toBe("confluence_space");
    const parsed = parseSourceConfig<{ space_key: string; recency_days: number }>(s);
    expect(parsed).toEqual({ space_key: "ENG", recency_days: 90 });
  });

  it("updateDocumentSourceCursor stores incremental watermark", () => {
    const s = createDocumentSource({
      path: "jira-project://ABC",
      label: "ABC",
      kind: "jira_project",
      config: { project_key: "ABC" },
    });
    expect(s.last_cursor).toBeNull();
    updateDocumentSourceCursor(s.id, "2026-03-15T00:00:00Z");
    const reloaded = getDocumentSource(s.id);
    expect(reloaded?.last_cursor).toBe("2026-03-15T00:00:00Z");
  });
});

describe("upsertRemoteDocument", () => {
  beforeEach(() => {
    for (const s of listDocumentSources()) deleteDocumentSource(s.id);
  });

  it("creates a document + chunks on first call (status=added)", async () => {
    const s = createDocumentSource({
      path: "jira-project://ABC", label: "ABC",
      kind: "jira_project", config: { project_key: "ABC" },
    });
    const r = await upsertRemoteDocument(s.id, {
      path: "jira://ABC-1",
      title: "ABC-1: outage",
      externalUpdatedAt: "2026-01-01T00:00:00Z",
      text: "Production database failed over to standby. Replication lag spiked to twelve hours during the incident.",
    });
    expect(r.status).toBe("added");
  });

  it("short-circuits with unchanged when content hash matches", async () => {
    const s = createDocumentSource({
      path: "jira-project://ABC", label: "ABC",
      kind: "jira_project", config: { project_key: "ABC" },
    });
    const input = {
      path: "jira://ABC-2",
      title: "ABC-2",
      externalUpdatedAt: "2026-01-01T00:00:00Z",
      text: "same body",
    };
    const r1 = await upsertRemoteDocument(s.id, input);
    expect(r1.status).toBe("added");

    // Same text, newer upstream timestamp → unchanged (content hash equal).
    const r2 = await upsertRemoteDocument(s.id, {
      ...input,
      externalUpdatedAt: "2026-02-01T00:00:00Z",
    });
    expect(r2.status).toBe("unchanged");
  });

  it("re-chunks on content change (status=updated)", async () => {
    const s = createDocumentSource({
      path: "jira-project://ABC", label: "ABC",
      kind: "jira_project", config: { project_key: "ABC" },
    });
    await upsertRemoteDocument(s.id, {
      path: "jira://ABC-3", title: "ABC-3",
      externalUpdatedAt: "2026-01-01T00:00:00Z",
      text: "original body",
    });
    const r = await upsertRemoteDocument(s.id, {
      path: "jira://ABC-3", title: "ABC-3 (renamed)",
      externalUpdatedAt: "2026-01-02T00:00:00Z",
      text: "different body content here",
    });
    expect(r.status).toBe("updated");
  });

  it("remote docs are reachable via searchDocuments (substring fallback)", async () => {
    const s = createDocumentSource({
      path: "confluence-space://ENG", label: "ENG",
      kind: "confluence_space", config: { space_key: "ENG" },
    });
    await upsertRemoteDocument(s.id, {
      path: "confluence://12345",
      title: "Kafka incident runbook",
      externalUpdatedAt: "2026-01-01T00:00:00Z",
      text: "Detect broker lag using JMX gauges. Mitigation: increase consumer parallelism and roll the broker.",
    });
    // No embedding provider in the test env, so this exercises the
    // substring fallback inside searchDocuments.
    const hits = await searchDocuments("kafka broker", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].rel_path).toBe("Kafka incident runbook");
    expect(hits[0].abs_path).toBe("confluence://12345");
  });

  it("falls back to substring when embedding dimensions mismatch", async () => {
    const s = createDocumentSource({
      path: "confluence-space://ENG", label: "ENG",
      kind: "confluence_space", config: { space_key: "ENG" },
    });
    const docPath = "confluence://99999";
    await upsertRemoteDocument(s.id, {
      path: docPath,
      title: "Kafka recovery notes",
      externalUpdatedAt: "2026-01-01T00:00:00Z",
      text: "Kafka broker restart checklist and email escalation path.",
    });

    // Simulate stale/legacy chunk vectors with a different dimension.
    getDb().prepare(
      `UPDATE document_chunks
       SET embedding = ?
       WHERE document_id = (SELECT id FROM documents WHERE path = ? LIMIT 1)`,
    ).run(JSON.stringify([0.1, 0.2]), docPath);

    const embeddings = await import("@/lib/embeddings");
    const embedOneSpy = vi.spyOn(embeddings, "embedOne").mockResolvedValue([0.9, 0.8, 0.7]);
    try {
      const hits = await searchDocuments("kafka broker", { limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].abs_path).toBe(docPath);
      expect(hits[0].match).toBe("substring");
    } finally {
      embedOneSpy.mockRestore();
    }
  });
});
