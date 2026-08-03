import { describe, expect, it } from "vitest";
import type { ModelConfig } from "@/api/types";
import type { ContentPart } from "@/lib/tools/types";
import { classifyTurn, finalizeRouteDecision, nextPolicyForRetry, routeTurnModel } from "./model-router";

function model(
  name: string,
  provider: string,
  modelId: string,
  overrides: Partial<ModelConfig["params"]> = {},
): ModelConfig {
  return {
    name,
    provider,
    model_id: modelId,
    params: {
      context_window_tokens: 32_000,
      ...overrides,
    },
    is_default: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function rateResolver(provider: string, modelId: string) {
  if (provider === "openai" && modelId === "gpt-4o-mini") return { inputPer1M: 0.2, outputPer1M: 0.8 };
  if (provider === "openai" && modelId === "o3") return { inputPer1M: 10, outputPer1M: 40 };
  if (provider === "anthropic" && modelId === "claude-haiku-4") return { inputPer1M: 0.6, outputPer1M: 3 };
  if (provider === "openai" && modelId === "gpt-4.1") return { inputPer1M: 4, outputPer1M: 12 };
  return { inputPer1M: 1, outputPer1M: 4 };
}

describe("classifyTurn", () => {
  it("classifies image-bearing turns as multimodal", () => {
    const attachments: ContentPart[] = [{ type: "image", media_type: "image/png", data: "abcd" }];
    expect(classifyTurn("What is in this screenshot?", attachments, ["web_search"])).toBe("multimodal");
  });

  it("classifies research prompts from language and tools", () => {
    expect(classifyTurn("Research this topic and compare the sources", [], ["web_search", "fetch_webpage"])).toBe("research");
  });
});

describe("routeTurnModel", () => {
  it("chooses a cheaper fast chat model for simple chat", () => {
    const result = routeTurnModel({
      models: [
        model("mini", "openai", "gpt-4o-mini"),
        model("reasoner", "openai", "o3"),
      ],
      message: "Write a short friendly reply",
      allowedTools: ["memory_read"],
      policy: "balanced",
      rateResolver,
    });
    expect(result.routeClass).toBe("simple-chat");
    expect(result.modelConfigName).toBe("mini");
  });

  it("routes complex prompts toward stronger reasoning models under quality policy", () => {
    const result = routeTurnModel({
      models: [
        model("mini", "openai", "gpt-4o-mini"),
        model("reasoner", "openai", "o3", { context_window_tokens: 128_000 }),
      ],
      message: "Debug the root cause and explain the architecture trade-offs step by step.",
      allowedTools: ["memory_read"],
      policy: "quality",
      rateResolver,
    });
    expect(result.routeClass).toBe("complex-reasoning");
    expect(result.modelConfigName).toBe("reasoner");
  });

  it("filters out non-vision models for multimodal turns", () => {
    const result = routeTurnModel({
      models: [
        model("text-only", "anthropic", "claude-2"),
        model("vision", "openai", "gpt-4.1"),
      ],
      message: "Describe this image",
      attachments: [{ type: "image", media_type: "image/png", data: "abcd" }],
      allowedTools: ["memory_read"],
      policy: "balanced",
      rateResolver,
    });
    expect(result.modelConfigName).toBe("vision");
    expect(result.candidates).toEqual(["vision"]);
  });

  it("prefers the last cached model when candidates are otherwise close", () => {
    const result = routeTurnModel({
      models: [
        model("haiku", "anthropic", "claude-haiku-4"),
        model("mini", "openai", "gpt-4o-mini"),
      ],
      message: "Summarize this and keep it concise",
      allowedTools: ["memory_read"],
      policy: "cheap",
      latestUsage: {
        model_config_name: "haiku",
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1200,
      },
      rateResolver,
    });
    expect(result.modelConfigName).toBe("haiku");
  });

  it("penalizes the last failed model when rerouting", () => {
    const result = routeTurnModel({
      models: [
        model("haiku", "anthropic", "claude-haiku-4"),
        model("mini", "openai", "gpt-4o-mini"),
      ],
      message: "Summarize this and keep it concise",
      allowedTools: ["memory_read"],
      policy: "fast",
      latestObservation: {
        source: "heuristic",
        model_config_name: "mini",
        reason: "previous turn",
        terminal: "error",
        error_code: "rate_limited",
        duration_ms: 9500,
      },
      rateResolver,
    });
    expect(result.modelConfigName).toBe("haiku");
  });
});

describe("route decision helpers", () => {
  it("records final route outcome", () => {
    expect(finalizeRouteDecision({ source: "heuristic", model_config_name: "mini", reason: "x" }, {
      durationMs: 1234,
      terminal: "done",
      retryCount: 1,
    })).toEqual({
      source: "heuristic",
      model_config_name: "mini",
      reason: "x",
      duration_ms: 1234,
      terminal: "done",
      error_code: undefined,
      retry_count: 1,
    });
  });

  it("escalates retry policy toward quality", () => {
    expect(nextPolicyForRetry("cheap")).toBe("balanced");
    expect(nextPolicyForRetry("fast")).toBe("balanced");
    expect(nextPolicyForRetry("balanced")).toBe("quality");
    expect(nextPolicyForRetry("quality")).toBe("quality");
  });
});