import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-anti-halluc-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { parseVerdict, resolveDetector } = await import("./hallucination-classifier");
const { upsertModelConfig, deleteModelConfig } = await import("@/lib/stores/model-config");
const { resetConfigCache } = await import("@/lib/env/config");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function setEnv(key: string, value: string | undefined): string | undefined {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  resetConfigCache();
  return prev;
}

describe("parseVerdict", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseVerdict('{"stalled": true, "reason": "no write tool called"}'))
      .toEqual({ stalled: true, reason: "no write tool called" });
  });

  it("parses stalled=false", () => {
    expect(parseVerdict('{"stalled": false, "reason": "tool ran"}'))
      .toEqual({ stalled: false, reason: "tool ran" });
  });

  it("strips a markdown code fence wrapping", () => {
    const wrapped = '```json\n{"stalled": true, "reason": "ok"}\n```';
    expect(parseVerdict(wrapped)).toEqual({ stalled: true, reason: "ok" });
  });

  it("extracts the verdict object even with surrounding prose", () => {
    const noisy = 'The model responded: {"stalled": true, "reason": "narration only"} — done.';
    expect(parseVerdict(noisy)).toEqual({ stalled: true, reason: "narration only" });
  });

  it("returns null on empty / whitespace input", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("   ")).toBeNull();
  });

  it("returns null when the JSON is malformed", () => {
    expect(parseVerdict('{"stalled": true,')).toBeNull();
    expect(parseVerdict("not json at all")).toBeNull();
  });

  it("returns null when stalled is not a boolean", () => {
    expect(parseVerdict('{"stalled": "yes", "reason": "stringly"}')).toBeNull();
    expect(parseVerdict('{"stalled": 1, "reason": "numbery"}')).toBeNull();
  });

  it("tolerates missing reason (uses empty string)", () => {
    expect(parseVerdict('{"stalled": true}')).toEqual({ stalled: true, reason: "" });
  });

  it("trims a long reason to 200 chars", () => {
    const longReason = "x".repeat(500);
    const r = parseVerdict(`{"stalled": false, "reason": "${longReason}"}`);
    expect(r?.reason.length).toBe(200);
  });

  it("ignores extra unknown fields", () => {
    expect(parseVerdict('{"stalled": true, "reason": "ok", "confidence": 0.7}'))
      .toEqual({ stalled: true, reason: "ok" });
  });
});

describe("resolveDetector", () => {
  // Each test pins env to a known state and restores afterwards. The
  // resolver also calls getModelConfig, so we seed real model rows when
  // a test needs the "model exists" branch.
  let prevMode: string | undefined;
  let prevModel: string | undefined;
  beforeEach(() => {
    prevMode = setEnv("JARELA_HALLUCINATION_DETECTOR_MODE", "regex");
    prevModel = setEnv("JARELA_HALLUCINATION_DETECTOR_MODEL", "");
  });
  afterAll(() => {
    setEnv("JARELA_HALLUCINATION_DETECTOR_MODE", prevMode);
    setEnv("JARELA_HALLUCINATION_DETECTOR_MODEL", prevModel);
  });

  it("returns env defaults when agent row is null", () => {
    expect(resolveDetector(null)).toEqual({ mode: "regex", modelConfigName: "" });
  });

  it("agent override 'off' wins over env default", () => {
    setEnv("JARELA_HALLUCINATION_DETECTOR_MODE", "regex");
    const out = resolveDetector({ anti_hallucination_mode: "off", anti_hallucination_model_config: null });
    expect(out.mode).toBe("off");
  });

  it("agent override 'model' uses agent's model name when DB row exists", () => {
    upsertModelConfig("test-haiku", "anthropic", "claude-haiku", { api_key: "sk-x" }, false);
    try {
      const out = resolveDetector({ anti_hallucination_mode: "model", anti_hallucination_model_config: "test-haiku" });
      expect(out).toEqual({ mode: "model", modelConfigName: "test-haiku" });
    } finally {
      deleteModelConfig("test-haiku");
    }
  });

  it("agent asks for 'model' but config doesn't exist → downgrades to regex", () => {
    const out = resolveDetector({ anti_hallucination_mode: "model", anti_hallucination_model_config: "no-such-config" });
    expect(out).toEqual({ mode: "regex", modelConfigName: "" });
  });

  it("env mode='model' with valid env model is honoured when agent has no override", () => {
    upsertModelConfig("env-classifier", "anthropic", "claude-haiku", { api_key: "sk-y" }, false);
    try {
      setEnv("JARELA_HALLUCINATION_DETECTOR_MODE", "model");
      setEnv("JARELA_HALLUCINATION_DETECTOR_MODEL", "env-classifier");
      const out = resolveDetector(null);
      expect(out).toEqual({ mode: "model", modelConfigName: "env-classifier" });
    } finally {
      deleteModelConfig("env-classifier");
    }
  });

  it("agent.model overrides env.model when both are set", () => {
    upsertModelConfig("agent-cls", "anthropic", "claude-haiku", { api_key: "sk-a" }, false);
    upsertModelConfig("env-cls", "anthropic", "claude-haiku", { api_key: "sk-b" }, false);
    try {
      setEnv("JARELA_HALLUCINATION_DETECTOR_MODEL", "env-cls");
      const out = resolveDetector({ anti_hallucination_mode: "model", anti_hallucination_model_config: "agent-cls" });
      expect(out.modelConfigName).toBe("agent-cls");
    } finally {
      deleteModelConfig("agent-cls");
      deleteModelConfig("env-cls");
    }
  });

  it("invalid stored mode value falls back to regex", () => {
    // The DB column is TEXT — a typo or a stale enum value should not
    // wedge the agent loop. Just default to regex.
    const out = resolveDetector({ anti_hallucination_mode: "report" as unknown as null, anti_hallucination_model_config: null });
    expect(out.mode).toBe("regex");
  });
});
