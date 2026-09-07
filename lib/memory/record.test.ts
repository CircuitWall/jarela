import { describe, expect, it } from "vitest";
import { isStructuredMemoryEligible, memoryRecallText, memorySearchText, parseStructuredMemory } from "./record";

const record = {
  version: 2 as const,
  kind: "decision" as const,
  subject: "Database choice",
  content: "Use SQLite for local-first persistence.",
  tags: ["architecture", "database"],
  confidence: "verified" as const,
  source: "tool_result" as const,
  observed_at: "2026-09-07T00:00:00.000Z",
  expires_at: null,
  summary: null,
  aliases: [] as string[],
  status: "active" as const,
  history: [] as never[],
};

describe("structured memory records", () => {
  it("builds a compact semantic search document from retrieval fields", () => {
    expect(memorySearchText("facts", "database-choice", record)).toContain("Database choice");
    expect(memorySearchText("facts", "database-choice", record)).toContain("architecture database");
    expect(memorySearchText("facts", "database-choice", record)).toContain("Use SQLite");
  });

  it("renders structured records for recall without raw JSON syntax", () => {
    expect(memoryRecallText("facts", "database-choice", record)).toBe(
      "Database choice: Use SQLite for local-first persistence. (decision | verified | observed: 2026-09-07 | tags: architecture, database)",
    );
  });

  it("excludes expired records while retaining legacy memory values", () => {
    expect(memoryRecallText("facts", "expired", { ...record, expires_at: "2020-01-01T00:00:00.000Z" })).toBeNull();
    expect(memoryRecallText("facts", "legacy", "plain legacy note")).toBe("plain legacy note");
    expect(parseStructuredMemory("not json")).toBeNull();
  });

  it("excludes archived records from recall and recall eligibility", () => {
    expect(memoryRecallText("facts", "archived", { ...record, status: "archived" })).toBeNull();
    expect(isStructuredMemoryEligible({ ...record, status: "archived" }, "detailed")).toBe(false);
  });

  it("upgrades a legacy v1 record to the current schema with v2 defaults", () => {
    const legacy = {
      version: 1,
      kind: "fact",
      subject: "Legacy subject",
      content: "Legacy content stored before v2.",
      tags: ["legacy"],
      confidence: "explicit",
      source: "conversation",
      observed_at: null,
      expires_at: null,
    };

    const upgraded = parseStructuredMemory(legacy);
    expect(upgraded).toMatchObject({ version: 2, status: "active", aliases: [], summary: null, subject: "Legacy subject" });
  });

  it("keeps important-mode recall focused on explicit or verified durable knowledge", () => {
    expect(isStructuredMemoryEligible(record, "important")).toBe(true);
    expect(isStructuredMemoryEligible({ ...record, confidence: "inferred" }, "important")).toBe(false);
    expect(isStructuredMemoryEligible({ ...record, kind: "task" }, "important")).toBe(false);
    expect(isStructuredMemoryEligible({ ...record, kind: "task" }, "detailed")).toBe(true);
  });
});