import { describe, expect, it } from "vitest";
import { formatRoutingDecisionSummary, formatRoutingDuration, humanizeRouteClass } from "./routing-decision";

describe("formatRoutingDecisionSummary", () => {
  it("formats heuristic routing with route class and policy", () => {
    expect(formatRoutingDecisionSummary({
      source: "heuristic",
      model_config_name: "mini",
      route_class: "simple-chat",
      policy: "balanced",
      reason: "chose mini",
      candidates: ["mini", "reasoner"],
    })).toBe("auto-routed to mini for simple chat (balanced)");
  });

  it("adds latency and retry count when present", () => {
    expect(formatRoutingDecisionSummary({
      source: "heuristic",
      model_config_name: "mini",
      route_class: "simple-chat",
      policy: "balanced",
      reason: "chose mini",
      duration_ms: 1234,
      retry_count: 1,
    })).toBe("auto-routed to mini for simple chat (balanced) · 1.2s · retried 1x");
  });

  it("formats pinned routing without optional fields", () => {
    expect(formatRoutingDecisionSummary({
      source: "pinned",
      model_config_name: "sonnet",
      reason: "queued run reused pinned model",
    })).toBe("pinned to sonnet");
  });

  it("shows placeholder when no model was available", () => {
    expect(formatRoutingDecisionSummary({
      source: "default_fallback",
      model_config_name: null,
      reason: "no runnable model was available",
    })).toBe("default fallback to (no model)");
  });
});

describe("humanizeRouteClass", () => {
  it("normalizes route class labels for UI", () => {
    expect(humanizeRouteClass("simple-chat")).toBe("simple chat");
    expect(humanizeRouteClass("complex-reasoning")).toBe("complex reasoning");
    expect(humanizeRouteClass("research")).toBe("research");
  });
});

describe("formatRoutingDuration", () => {
  it("formats milliseconds and seconds compactly", () => {
    expect(formatRoutingDuration(250)).toBe("250ms");
    expect(formatRoutingDuration(1234)).toBe("1.2s");
    expect(formatRoutingDuration(12_100)).toBe("12s");
  });
});