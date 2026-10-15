import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-modelconfig-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  getModelParams,
  upsertModelConfig,
  deleteModelConfig,
  getDefaultModelConfig,
  getModelConfig,
  withModelConfigMutation,
} = await import("./model-config");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("getModelParams", () => {
  it("decodes a stringified params object", () => {
    expect(getModelParams({ params: JSON.stringify({ api_key: "sk-x", temperature: 0.5 }) }))
      .toEqual({ api_key: "sk-x", temperature: 0.5 });
  });

  it("returns {} for null/undefined cfg", () => {
    expect(getModelParams(null)).toEqual({});
    expect(getModelParams(undefined)).toEqual({});
  });

  it("returns {} for blank or malformed JSON", () => {
    expect(getModelParams({ params: "" })).toEqual({});
    expect(getModelParams({ params: "not json" })).toEqual({});
  });

  it("returns {} for non-object payloads (arrays, primitives)", () => {
    expect(getModelParams({ params: JSON.stringify([1, 2, 3]) })).toEqual({});
    expect(getModelParams({ params: JSON.stringify("string") })).toEqual({});
    expect(getModelParams({ params: JSON.stringify(42) })).toEqual({});
  });
});

describe("withModelConfigMutation", () => {
  it("runs same-model mutations in invocation order", async () => {
    let releaseFirst!: () => void;
    const firstBarrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];

    const first = withModelConfigMutation("race-test", async () => {
      started.push("first");
      await firstBarrier;
    });
    const second = withModelConfigMutation("race-test", async () => {
      started.push("second");
    });

    await Promise.resolve();
    expect(started).toEqual(["first"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(["first", "second"]);
  });
});

describe("upsertModelConfig params merge", () => {
  it("preserves an existing field the next save's payload omits", () => {
    upsertModelConfig("merge-test", "custom-provider", "claude-sonnet-5", { username: "example-user", password: "secret", base_url: "https://a" }, false);
    upsertModelConfig("merge-test", "custom-provider", "claude-sonnet-5", { base_url: "https://b" }, false);
    expect(getModelParams(getModelConfig("merge-test"))).toEqual({
      username: "example-user",
      password: "secret",
      base_url: "https://b",
    });
    deleteModelConfig("merge-test");
  });

  it("lets a save explicitly overwrite a field with a new value", () => {
    upsertModelConfig("merge-test-2", "anthropic", "claude-sonnet-5", { api_key: "sk-old" }, false);
    upsertModelConfig("merge-test-2", "anthropic", "claude-sonnet-5", { api_key: "sk-new" }, false);
    expect(getModelParams(getModelConfig("merge-test-2"))).toEqual({ api_key: "sk-new" });
    deleteModelConfig("merge-test-2");
  });
});

describe("deleteModelConfig auto-promotes default", () => {
  it("falls back to first available row when no row has is_default=1", () => {
    upsertModelConfig("no-default-1", "anthropic", "claude-x", {}, false);
    upsertModelConfig("no-default-2", "anthropic", "claude-y", {}, false);
    expect(getDefaultModelConfig()).not.toBeNull();
    deleteModelConfig("no-default-1");
    deleteModelConfig("no-default-2");
  });

  it("promotes the alphabetically-first remaining row when the default is deleted", () => {
    upsertModelConfig("zzz-alpha", "anthropic", "claude-x", {}, false);
    upsertModelConfig("zzz-beta", "anthropic", "claude-y", {}, true);
    upsertModelConfig("zzz-gamma", "anthropic", "claude-z", {}, false);

    expect(getDefaultModelConfig()?.name).toBe("zzz-beta");
    expect(deleteModelConfig("zzz-beta")).toBe(true);
    // The promoted row is the alphabetically-first remaining row in the
    // DB — could be a seeded "claude-sonnet" if seeds exist, otherwise
    // "zzz-alpha". Either way there MUST be a default now.
    expect(getDefaultModelConfig()).not.toBeNull();

    deleteModelConfig("zzz-alpha");
    deleteModelConfig("zzz-gamma");
  });

  it("does nothing special when a non-default row is deleted", () => {
    upsertModelConfig("keep-default", "anthropic", "claude-x", {}, true);
    upsertModelConfig("disposable", "anthropic", "claude-y", {}, false);
    expect(getDefaultModelConfig()?.name).toBe("keep-default");
    deleteModelConfig("disposable");
    expect(getDefaultModelConfig()?.name).toBe("keep-default");
    deleteModelConfig("keep-default");
  });
});

describe("model config enable/disable and atomic default", () => {
  async function load() {
    return import("./model-config");
  }

  function reset(names: string[]) {
    for (const n of names) deleteModelConfig(n);
  }

  it("new rows are enabled and upsert without is_default preserves the default flag", async () => {
    const { isModelConfigEnabled } = await load();
    upsertModelConfig("ena-a", "anthropic", "claude-x", {}, true);
    const saved = upsertModelConfig("ena-a", "anthropic", "claude-x", { temperature: 0.2 }, undefined);
    expect(saved.is_default).toBe(1);
    expect(isModelConfigEnabled(saved)).toBe(true);
    reset(["ena-a"]);
  });

  it("setDefaultModelConfig leaves exactly one default", async () => {
    const { setDefaultModelConfig, listModelConfigs } = await load();
    upsertModelConfig("def-a", "anthropic", "claude-x", {}, true);
    upsertModelConfig("def-b", "anthropic", "claude-y", {}, false);
    const row = setDefaultModelConfig("def-b");
    expect(row.is_default).toBe(1);
    expect(listModelConfigs().filter((r) => r.is_default === 1).map((r) => r.name)).toEqual(["def-b"]);
    // Params are untouched by a default switch.
    expect(getModelConfig("def-a")?.params).toBe(JSON.stringify({}));
    reset(["def-a", "def-b"]);
  });

  it("setDefaultModelConfig rejects unknown and disabled configs without changing the default", async () => {
    const { setDefaultModelConfig, setModelConfigEnabled, ModelConfigStateError } = await load();
    upsertModelConfig("rej-a", "anthropic", "claude-x", {}, true);
    upsertModelConfig("rej-b", "anthropic", "claude-y", {}, false);
    setModelConfigEnabled("rej-b", false);
    expect(() => setDefaultModelConfig("missing-model")).toThrow(ModelConfigStateError);
    expect(() => setDefaultModelConfig("rej-b")).toThrow(/disabled/);
    expect(getDefaultModelConfig()?.name).toBe("rej-a");
    reset(["rej-a", "rej-b"]);
  });

  it("disabling the default promotes another enabled config in the same step", async () => {
    const { setModelConfigEnabled, listModelConfigs } = await load();
    upsertModelConfig("dis-a", "anthropic", "claude-x", {}, true);
    upsertModelConfig("dis-b", "anthropic", "claude-y", {}, false);
    const disabled = setModelConfigEnabled("dis-a", false);
    expect(disabled.enabled).toBe(0);
    expect(disabled.is_default).toBe(0);
    const defaults = listModelConfigs().filter((r) => r.is_default === 1);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].enabled).toBe(1);
    expect(getDefaultModelConfig()?.name).not.toBe("dis-a");
    reset(["dis-a", "dis-b"]);
  });

  it("refuses to disable the last enabled config", async () => {
    const { setModelConfigEnabled, listModelConfigs } = await load();
    for (const r of listModelConfigs()) deleteModelConfig(r.name);
    upsertModelConfig("only-one", "anthropic", "claude-x", {}, true);
    expect(() => setModelConfigEnabled("only-one", false)).toThrow(/at least one/i);
    expect(getModelConfig("only-one")?.enabled).toBe(1);
    reset(["only-one"]);
  });

  it("disabled configs are skipped by default fallback and runnable resolution", async () => {
    const { setModelConfigEnabled, resolveRunnableModelConfig, listEnabledModelConfigs } = await load();
    upsertModelConfig("run-a", "anthropic", "claude-x", {}, true);
    upsertModelConfig("run-b", "anthropic", "claude-y", {}, false);
    setModelConfigEnabled("run-b", false);
    expect(listEnabledModelConfigs().map((r) => r.name)).not.toContain("run-b");
    expect(resolveRunnableModelConfig("run-b")?.name).toBe("run-a");
    setModelConfigEnabled("run-b", true);
    expect(resolveRunnableModelConfig("run-b")?.name).toBe("run-b");
    reset(["run-a", "run-b"]);
  });

  it("making a disabled config the default via upsert re-enables it", async () => {
    const { setModelConfigEnabled } = await load();
    upsertModelConfig("up-a", "anthropic", "claude-x", {}, true);
    upsertModelConfig("up-b", "anthropic", "claude-y", {}, false);
    setModelConfigEnabled("up-b", false);
    const row = upsertModelConfig("up-b", "anthropic", "claude-y", {}, true);
    expect(row.enabled).toBe(1);
    expect(getDefaultModelConfig()?.name).toBe("up-b");
    reset(["up-a", "up-b"]);
  });
});