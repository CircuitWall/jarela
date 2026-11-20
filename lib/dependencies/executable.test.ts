import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable, isExecutableOnPath, resetExecutableCache } from "./executable";

const root = mkdtempSync(join(tmpdir(), "jarela-dep-exec-"));

// POSIX-style PATHs are simulated on Windows hosts too. Strip the drive
// letter so the entry contains no ":" (which would be read as a PATH
// separator); the resulting path still resolves on the same drive.
function forPosix(input: string): string {
  return process.platform === "win32" ? input.replace(/^[A-Za-z]:/, "") : input;
}

const posixBin = forPosix(join(root, "posix-bin"));
const winBin = join(root, "win-bin");
mkdirSync(posixBin, { recursive: true });
mkdirSync(winBin, { recursive: true });

writeFileSync(join(posixBin, "fake-tool"), "#!/bin/sh\nexit 0\n");
chmodSync(join(posixBin, "fake-tool"), 0o755);
writeFileSync(join(winBin, "fake-tool.CMD"), "@echo off\r\n");
writeFileSync(join(winBin, "fake-tool.txt"), "not executable");

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  resetExecutableCache();
});

describe("findExecutable", () => {
  const posixTool = join(posixBin, "fake-tool");
  const lateBin = forPosix(join(root, "late-bin"));

  it("finds a binary on a POSIX PATH", () => {
    expect(findExecutable("fake-tool", { env: { PATH: posixBin }, platform: "linux" })).toBe(posixTool);
    expect(isExecutableOnPath("fake-tool", { env: { PATH: posixBin }, platform: "linux" })).toBe(true);
  });

  it("searches multiple PATH entries in order", () => {
    const empty = forPosix(join(root, "empty"));
    mkdirSync(empty, { recursive: true });
    const found = findExecutable("fake-tool", {
      env: { PATH: `${empty}:${posixBin}` },
      platform: "linux",
    });
    expect(found).toBe(posixTool);
  });

  it("returns null when the binary is absent or PATH is empty", () => {
    expect(findExecutable("missing-tool", { env: { PATH: posixBin }, platform: "linux" })).toBeNull();
    expect(findExecutable("fake-tool", { env: { PATH: "" }, platform: "linux" })).toBeNull();
    expect(findExecutable("", { env: { PATH: posixBin }, platform: "linux" })).toBeNull();
  });

  it("honours PATHEXT on Windows and ignores non-executable extensions", () => {
    expect(findExecutable("fake-tool", { env: { PATH: winBin, PATHEXT: ".CMD" }, platform: "win32" }))
      .toBe(join(winBin, "fake-tool.CMD"));
    expect(findExecutable("fake-tool.txt", { env: { PATH: winBin, PATHEXT: ".CMD" }, platform: "win32" }))
      .toBeNull();
  });

  it("resolves path-like names directly", () => {
    expect(findExecutable(posixTool, { env: {}, platform: "linux" })).toBe(posixTool);
    expect(findExecutable(join(posixBin, "nope"), { env: {}, platform: "linux" })).toBeNull();
  });

  it("caches lookups until forced or reset", () => {
    mkdirSync(lateBin, { recursive: true });
    expect(findExecutable("late-tool", { env: { PATH: lateBin }, platform: "linux" })).toBeNull();

    writeFileSync(join(lateBin, "late-tool"), "#!/bin/sh\n");
    chmodSync(join(lateBin, "late-tool"), 0o755);
    // Cached miss: an install is expected to call with force or reset the cache.
    expect(findExecutable("late-tool", { env: { PATH: lateBin }, platform: "linux" })).toBeNull();
    expect(findExecutable("late-tool", { env: { PATH: lateBin }, platform: "linux", force: true }))
      .toBe(join(lateBin, "late-tool"));
  });
});
