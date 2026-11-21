import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  ensure: vi.fn(),
}));

vi.mock("@/lib/db/data-dir", () => ({ getDataDir: () => mocks.dataDir }));
vi.mock("./whisper-model-assets.mjs", () => ({
  WHISPER_MODEL_FILES: [{ path: "onnx/encoder_model_quantized.onnx", size: 3 }],
  WHISPER_MODEL_TOTAL_BYTES: 3,
  whisperModelDir: (root: string) => join(root, "Xenova", "whisper-tiny"),
  ensureWhisperModelAssets: mocks.ensure,
}));

const {
  WhisperModelNotReadyError,
  downloadedWhisperRoot,
  getWhisperModelStatus,
  requireWhisperModelRoot,
  startWhisperModelDownload,
} = await import("./whisper-model");

let dir: string;

function install(root: string) {
  const model = join(root, "Xenova", "whisper-tiny", "onnx");
  mkdirSync(model, { recursive: true });
  writeFileSync(join(model, "encoder_model_quantized.onnx"), "abc");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarela-whisper-model-"));
  mocks.dataDir = join(dir, "data");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  delete process.env.JARELA_WHISPER_DOWNLOAD;
  (globalThis as { __jarelaWhisperModelDownload?: unknown }).__jarelaWhisperModelDownload = undefined;
  mocks.ensure.mockReset().mockImplementation(async (root: string) => {
    install(root);
    return "downloaded";
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("on-demand Whisper input model", () => {
  it("installs under the data directory and prefers a bundled copy", () => {
    expect(downloadedWhisperRoot()).toBe(join(dir, "data", "models", "whisper"));
    install(join(dir, ".jarela-assets", "whisper"));

    expect(requireWhisperModelRoot()).toBe(`${join(dir, ".jarela-assets", "whisper")}${sep}`);
    expect(getWhisperModelStatus()).toMatchObject({ state: "ready", source: "bundled" });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("downloads once in the background and fails fast until it lands", async () => {
    let finish!: () => void;
    mocks.ensure.mockImplementation((root: string) => new Promise((resolve) => {
      finish = () => { install(root); resolve("downloaded"); };
    }));

    expect(() => requireWhisperModelRoot()).toThrow(WhisperModelNotReadyError);
    expect(() => requireWhisperModelRoot()).toThrow(/downloading/);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.ensure.mock.calls[0][0]).toBe(join(dir, "data", "models", "whisper"));
    expect(getWhisperModelStatus().state).toBe("downloading");

    finish();
    await expect(startWhisperModelDownload()).resolves.toBe(`${join(dir, "data", "models", "whisper")}${sep}`);
    expect(getWhisperModelStatus()).toMatchObject({ state: "ready", source: "downloaded" });
    expect(requireWhisperModelRoot()).toBe(`${join(dir, "data", "models", "whisper")}${sep}`);
  });

  it("backs off after a failure unless the user retries explicitly", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.ensure.mockRejectedValueOnce(new Error("download failed (503)"));

    await expect(startWhisperModelDownload()).rejects.toThrow("503");
    expect(getWhisperModelStatus()).toMatchObject({ state: "failed", error: "download failed (503)" });
    expect(() => requireWhisperModelRoot()).toThrow(/download failed \(503\)/);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);

    await expect(startWhisperModelDownload({ force: true })).resolves.toContain("whisper");
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
  });

  it("honours the download kill switch", () => {
    process.env.JARELA_WHISPER_DOWNLOAD = "0";
    expect(getWhisperModelStatus()).toMatchObject({ state: "missing" });
    expect(() => requireWhisperModelRoot()).toThrow(/JARELA_WHISPER_DOWNLOAD=0/);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
});
