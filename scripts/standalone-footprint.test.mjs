import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findStandaloneFootprintProblems, pruneStandaloneFootprint } from "./standalone-footprint.mjs";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

const target = { platform: "linux", arch: "x64" };
let dir;

function binding(platform, arch) {
  const binDir = join(dir, "node_modules", "onnxruntime-node", "bin", "napi-v6", platform, arch);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "onnxruntime_binding.node"), "");
}

function setup() {
  dir = mkdtempSync(join(tmpdir(), "jarela-footprint-"));
  binding(target.platform, target.arch);
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("findStandaloneFootprintProblems", () => {
  it("accepts a bundle with only the target platform binding", () => {
    setup();
    expect(findStandaloneFootprintProblems(dir, target)).toEqual([]);
  });

  it("flags a traced .git directory", () => {
    setup();
    mkdirSync(join(dir, ".git"));
    expect(findStandaloneFootprintProblems(dir, target)).toEqual([".git was traced into the standalone bundle"]);
  });

  it("flags a missing target binding and foreign platform binaries", () => {
    setup();
    binding("win32", "x64");
    binding("linux", "arm64");
    rmSync(join(dir, "node_modules", "onnxruntime-node", "bin", "napi-v6", "linux", "x64"), { recursive: true });

    expect(findStandaloneFootprintProblems(dir, target)).toEqual([
      "onnxruntime-node binding for linux/x64 is missing",
      "onnxruntime-node binaries for linux/arm64 should not be bundled",
      "onnxruntime-node binaries for win32/x64 should not be bundled",
    ]);
  });

  it("flags the unused browser ONNX backend", () => {
    setup();
    mkdirSync(join(dir, "node_modules", "onnxruntime-web", "dist"), { recursive: true });
    expect(findStandaloneFootprintProblems(dir, target)).toEqual([
      "onnxruntime-web (browser backend) should not be bundled",
    ]);
  });
});

describe("pruneStandaloneFootprint", () => {
  it("uses bounded native retries when removing traced Git metadata", () => {
    setup();
    mkdirSync(join(dir, ".git"));
    pruneStandaloneFootprint(dir, target);
    expect(rmSync).toHaveBeenCalledWith(join(dir, ".git"), {
      recursive: true, force: true, maxRetries: 5, retryDelay: 100,
    });
  });

  it("removes read-only traced Git files while preserving the target binding", () => {
    setup();
    const objects = join(dir, ".git", "objects");
    mkdirSync(objects, { recursive: true });
    const object = join(objects, "synthetic-object");
    writeFileSync(object, "synthetic git object");
    chmodSync(object, 0o444);
    expect(pruneStandaloneFootprint(dir, target)).toEqual([join(dir, ".git")]);
    expect(findStandaloneFootprintProblems(dir, target)).toEqual([]);
  });

  it("still rejects a bundle when cleanup fails after native retries", () => {
    setup();
    mkdirSync(join(dir, ".git"));
    const error = Object.assign(new Error("synthetic permission failure"), { code: "EPERM" });
    vi.mocked(rmSync).mockImplementationOnce(() => { throw error; });
    expect(() => pruneStandaloneFootprint(dir, target)).toThrow(error);
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("removes traced extras and keeps only the target binding", () => {
    setup();
    mkdirSync(join(dir, ".git", "objects"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "onnxruntime-web", "dist"), { recursive: true });
    binding("linux", "arm64");
    binding("darwin", "arm64");
    binding("win32", "x64");

    const removed = pruneStandaloneFootprint(dir, target);

    expect(removed).toHaveLength(5);
    expect(findStandaloneFootprintProblems(dir, target)).toEqual([]);
    expect(existsSync(join(dir, "node_modules", "onnxruntime-node", "bin", "napi-v6", "linux", "x64", "onnxruntime_binding.node"))).toBe(true);
    expect(pruneStandaloneFootprint(dir, target)).toEqual([]);
  });
});
