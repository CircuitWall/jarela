import { describe, expect, it } from "vitest";
import type { ModelConfig } from "@/api/types";
import { agentModelStatus, isModelEnabled, resolveAgentModel } from "./effective-model";

function model(name: string, extra: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name,
    provider: "mock",
    model_id: `${name}-id`,
    params: {},
    is_default: false,
    enabled: true,
    created_at: "",
    updated_at: "",
    ...extra,
  };
}

describe("resolveAgentModel", () => {
  it("uses the explicit model when it is enabled", () => {
    const models = [model("a", { is_default: true }), model("b")];
    expect(resolveAgentModel({ model_config_name: "b" }, models)?.name).toBe("b");
  });

  it("falls back to the default when the explicit model is disabled", () => {
    const models = [model("a", { is_default: true }), model("b", { enabled: false })];
    expect(resolveAgentModel({ model_config_name: "b" }, models)?.name).toBe("a");
  });

  it("never picks a disabled model as the implicit default", () => {
    const models = [model("a", { enabled: false }), model("b")];
    expect(resolveAgentModel(null, models)?.name).toBe("b");
  });

  it("reports no-model when every config is disabled", () => {
    const models = [model("a", { enabled: false, is_default: true })];
    expect(agentModelStatus({ model_config_name: null }, models)).toEqual({ state: "no-model" });
  });

  it("treats rows without the enabled field as enabled", () => {
    const legacy = { ...model("a") } as Partial<ModelConfig>;
    delete legacy.enabled;
    expect(isModelEnabled(legacy as ModelConfig)).toBe(true);
  });
});
