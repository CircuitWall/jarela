import { describe, expect, it } from "vitest";
import { isStructuredMemoryEligible, memoryRecallText, memorySearchText, parseStructuredMemory } from "./record";

const record = {
  version: 1 as const,
  kind: "decision" as const,
  subject: "Database choice",
  content: "Use SQLite for local-first persistence.",
  tags: ["architecture", "database"],
  confidence: "verified" as const,
  source: "tool_result" as const,
  observed_at: "2026-09-07T00:00:00.000Z",
  expires_at: null,
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

  it("keeps important-mode recall focused on explicit or verified durable knowledge", () => {
    expect(isStructuredMemoryEligible(record, "important")).toBe(true);
    expect(isStructuredMemoryEligible({ ...record, confidence: "inferred" }, "important")).toBe(false);
    expect(isStructuredMemoryEligible({ ...record, kind: "task" }, "important")).toBe(false);
    expect(isStructuredMemoryEligible({ ...record, kind: "task" }, "detailed")).toBe(true);
  });
});