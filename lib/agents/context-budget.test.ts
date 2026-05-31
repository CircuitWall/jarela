import { describe, it, expect } from "vitest";
import {
  computeContextBudget,
  normalizeTierPriority,
  normalizeTierProportions,
  takeRecentMessagesWithinBudget,
  truncateLargestMessagesWithinBudget,
  estimateTokens,
} from "./context-budget";
import type { MessageRow } from "@/lib/stores/threads";

function msg(content: string): MessageRow {
  return {
    msg_id: "m",
    thread_id: "t",
    role: "user",
    content,
    created_at: "2026-01-01T00:00:00.000Z",
    tool_events: null,
    category: null,
  };
}

describe("estimateTokens", () => {
  it("uses a 4-char token heuristic with minimum 1 for non-empty text", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("returns 0 for empty/whitespace input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   ")).toBe(0);
  });
});

describe("normalizeTierPriority", () => {
  it("accepts valid permutations", () => {
    expect(normalizeTierPriority(["facts", "warm", "hot"]))
      .toEqual(["facts", "warm", "hot"]);
  });

  it("falls back to default for invalid values", () => {
    expect(normalizeTierPriority(["hot", "hot", "warm"]))
      .toEqual(["hot", "warm", "facts"]);
    expect(normalizeTierPriority(["hot", "warm"]))
      .toEqual(["hot", "warm", "facts"]);
    expect(normalizeTierPriority("bad"))
      .toEqual(["hot", "warm", "facts"]);
  });
});

describe("normalizeTierProportions", () => {
  it("normalizes arbitrary positive numbers to sum to 1", () => {
    const p = normalizeTierProportions({ hot: 2, warm: 1, facts: 1 });
    expect(p.hot).toBeCloseTo(0.5, 6);
    expect(p.warm).toBeCloseTo(0.25, 6);
    expect(p.facts).toBeCloseTo(0.25, 6);
  });

  it("falls back to defaults when values are non-positive", () => {
    const p = normalizeTierProportions({ hot: 0, warm: -1, facts: 0 });
    expect(p.hot).toBeCloseTo(0.6, 6);
    expect(p.warm).toBeCloseTo(0.25, 6);
    expect(p.facts).toBeCloseTo(0.15, 6);
  });
});

describe("computeContextBudget", () => {
  it("applies defaults when model params are absent", () => {
    const b = computeContextBudget({});
    expect(b.contextWindowTokens).toBe(8192);
    expect(b.outputReserveTokens).toBe(1638);
    expect(b.overheadTokens).toBe(1200);
    expect(b.inputBudgetTokens).toBe(5354);
    expect(b.tierPriority).toEqual(["hot", "warm", "facts"]);
    expect(b.tierBudgets.hot + b.tierBudgets.warm + b.tierBudgets.facts).toBe(b.inputBudgetTokens);
  });

  it("respects explicit max_tokens and context_window_tokens", () => {
    const b = computeContextBudget({
      context_window_tokens: 10000,
      max_tokens: 500,
      context_tier_proportions: { hot: 0.5, warm: 0.3, facts: 0.2 },
      context_tier_priority: ["warm", "facts", "hot"],
    });
    expect(b.contextWindowTokens).toBe(10000);
    expect(b.outputReserveTokens).toBe(500);
    expect(b.tierPriority).toEqual(["warm", "facts", "hot"]);
    expect(b.tierBudgets.hot + b.tierBudgets.warm + b.tierBudgets.facts).toBe(b.inputBudgetTokens);
  });

  it("enforces minimum output reserve", () => {
    const b = computeContextBudget({ context_window_tokens: 600, max_tokens: 1 });
    expect(b.outputReserveTokens).toBe(256);
  });
});

describe("takeRecentMessagesWithinBudget", () => {
  it("returns most-recent-first slice bounded by token budget", () => {
    const rows = [
      msg("first message has some words"),
      msg("second message has some words"),
      msg("third message has some words"),
    ];
    // One message is about 7 tokens with current heuristic.
    const out = takeRecentMessagesWithinBudget(rows, 10);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain("third");
  });

  it("always includes latest message when budget is tiny", () => {
    const rows = [msg("older"), msg("latest message with many chars")];
    const out = takeRecentMessagesWithinBudget(rows, 1);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain("latest");
  });

  it("handles attachment-encoded content via transcriptText path", () => {
    const withAttachment = JSON.stringify([
      { type: "text", text: "hello" },
      { type: "file", name: "doc.txt", media_type: "text/plain", data: "x" },
    ]);
    const rows = [msg(withAttachment), msg("latest")];
    const out = takeRecentMessagesWithinBudget(rows, 8);
    expect(out.at(-1)?.content).toBe("latest");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("truncateLargestMessagesWithinBudget", () => {
  it("returns input unchanged when already within budget", () => {
    const rows = [msg("short"), msg("also short")];
    const out = truncateLargestMessagesWithinBudget(rows, 40);
    expect(out.map((r) => r.content)).toEqual(rows.map((r) => r.content));
  });

  it("truncates the largest message until the total fits budget", () => {
    const rows = [
      msg("tiny"),
      msg("x".repeat(2000)),
      msg("recent note"),
    ];
    const out = truncateLargestMessagesWithinBudget(rows, 120);
    const total = out.reduce((sum, r) => sum + estimateTokens(r.content), 0);
    expect(total).toBeLessThanOrEqual(120);
    expect(out[1].content).toContain("[truncated for context budget]");
  });
});
