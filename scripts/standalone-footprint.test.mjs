import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findStandaloneFootprintProblems, pruneStandaloneFootprint } from "./standalone-footprint.mjs";

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
