import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  ensure: vi.fn(),
}));

vi.mock("@/lib/db/data-dir", () => ({ getDataDir: () => mocks.dataDir }));
vi.mock("./local-model-assets.mjs", () => ({
  LOCAL_MODEL_FILES: [{ path: "onnx/model.onnx", size: 3 }],
  LOCAL_MODEL_TOTAL_BYTES: 3,
  localModelDir: (root: string) => join(root, "Xenova", "multilingual-e5-small"),
  ensureLocalModelAssets: mocks.ensure,
}));

const {
  LocalModelNotReadyError,
  getLocalModelStatus,
  requireLocalModelRoot,
  startLocalModelDownload,
} = await import("./local-model");

let dir: string;

function install(root: string) {
  const model = join(root, "Xenova", "multilingual-e5-small", "onnx");
  mkdirSync(model, { recursive: true });
  writeFileSync(join(model, "model.onnx"), "abc");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarela-local-model-"));
  mocks.dataDir = join(dir, "data");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  delete process.env.JARELA_LOCAL_EMBEDDING_DOWNLOAD;
  (globalThis as { __jarelaLocalModelDownload?: unknown }).__jarelaLocalModelDownload = undefined;
  mocks.ensure.mockReset().mockImplementation(async (root: string) => {
    install(root);
    return "downloaded";
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("on-demand local embedding model", () => {
  it("prefers a bundled model without downloading", () => {
    install(join(dir, ".jarela-assets", "local-embedding"));

    expect(requireLocalModelRoot()).toBe(`${join(dir, ".jarela-assets", "local-embedding")}${sep}`);
    expect(getLocalModelStatus()).toMatchObject({ state: "ready", source: "bundled" });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("starts one background download and fails fast with a transient error until it lands", async () => {
    let finish!: () => void;
    mocks.ensure.mockImplementation((root: string) => new Promise((resolve) => {
      finish = () => { install(root); resolve("downloaded"); };
    }));

    expect(() => requireLocalModelRoot()).toThrow(LocalModelNotReadyError);
    expect(() => requireLocalModelRoot()).toThrow(/downloading/);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.ensure.mock.calls[0][0]).toBe(join(dir, "data", "models", "local-embedding"));
    expect(getLocalModelStatus().state).toBe("downloading");

    finish();
    await expect(startLocalModelDownload()).resolves.toBe(`${join(dir, "data", "models", "local-embedding")}${sep}`);
    expect(getLocalModelStatus()).toMatchObject({ state: "ready", source: "downloaded" });
    expect(requireLocalModelRoot()).toBe(`${join(dir, "data", "models", "local-embedding")}${sep}`);
  });

  it("backs off after a failure unless the user retries explicitly", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.ensure.mockRejectedValueOnce(new Error("download failed (503)"));

    await expect(startLocalModelDownload()).rejects.toThrow("503");
    expect(getLocalModelStatus()).toMatchObject({ state: "failed", error: "download failed (503)" });
    expect(() => requireLocalModelRoot()).toThrow(/download failed \(503\)/);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);

    await expect(startLocalModelDownload({ force: true })).resolves.toContain("local-embedding");
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
  });

  it("never downloads when JARELA_LOCAL_EMBEDDING_DOWNLOAD=0", async () => {
    process.env.JARELA_LOCAL_EMBEDDING_DOWNLOAD = "0";

    expect(() => requireLocalModelRoot()).toThrow(/JARELA_LOCAL_EMBEDDING_DOWNLOAD=0/);
    await expect(startLocalModelDownload({ force: true })).rejects.toThrow(/model:prepare/);
    expect(getLocalModelStatus().state).toBe("missing");
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
});
