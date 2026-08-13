// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextUsageBar } from "./ContextUsageBar";
import type { MessageUsage } from "@/api/types";

function mkUsage(overrides: Partial<MessageUsage> = {}): MessageUsage {
  return {
    input_tokens: 1200,
    output_tokens: 400,
    hot_tokens: 300,
    warm_tokens: 200,
    facts_tokens: 100,
    overhead_tokens: 80,
    hot_budget_tokens: 500,
    warm_budget_tokens: 300,
    facts_budget_tokens: 200,
    context_window_tokens: 4096,
    cache_creation_input_tokens: 64,
    cache_read_input_tokens: 256,
    thinking_tokens: 42,
    cost_usd: 0.1234,
    ...overrides,
  };
}

describe("ContextUsageBar", () => {
  it("does not render per-message cost while keeping efficiency chips", () => {
    render(<ContextUsageBar usage={mkUsage()} fallbackContextWindow={4096} />);

    // Efficiency chips remain visible.
    expect(screen.getByText(/thinking/i)).toBeTruthy();
    expect(screen.getByText(/cached/i)).toBeTruthy();
    expect(screen.getByText(/written/i)).toBeTruthy();

    // Per-message cost is intentionally hidden from this surface.
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText(/estimated turn cost/i)).toBeNull();
  });
});
