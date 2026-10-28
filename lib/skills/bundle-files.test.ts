import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portableSkillPath, readSkillTextFile } from "./bundle-files";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readSync: vi.fn(actual.readSync), closeSync: vi.fn(actual.closeSync), openSync: vi.fn(actual.openSync) };
});

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

describe("skill-root-relative resource reads", () => {
  const dirs: string[] = [];
  function directory() {
    const dir = mkdtempSync(join(tmpdir(), "jarela-skill-resource-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    vi.resetAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads exact UTF-8 bytes under the bundle, including paths with spaces", () => {
    const dir = directory();
    mkdirSync(join(dir, "references with spaces"));
    writeFileSync(join(dir, "references with spaces", "guide.md"), "café\n");
    expect(readSkillTextFile(dir, "references with spaces/guide.md", 6)).toEqual({ content: "café\n", bytes: 6 });
    writeFileSync(join(dir, "empty.txt"), "");
    expect(readSkillTextFile(dir, "empty.txt", 1)).toEqual({ content: "", bytes: 0 });
  });

  it.each([
    "", ".", "..", "../secret.txt", "/etc/passwd", "C:/file.txt", "//server/file.txt",
    "references/../secret.txt", "./asset.json", "references//guide.md", "refs\\guide.md",
    "file:stream", "file.", "dir /file", "NUL.txt", "conin$.txt", "bad\u0000.md", "bad\u007f.md",
    "x".repeat(241),
  ])("rejects escaping or nonportable paths before I/O: %j", (path) => {
    expect(portableSkillPath.safeParse(path).success).toBe(false);
    expect(() => readSkillTextFile(directory(), path, 100)).toThrow();
  });

  it("rejects missing, nonregular, binary and invalid UTF-8 resources explicitly", () => {
    const dir = directory();
    expect(() => readSkillTextFile(dir, "missing.md", 20)).toThrow(/ENOENT/);
    mkdirSync(join(dir, "folder"));
    expect(() => readSkillTextFile(dir, "folder", 20)).toThrow(/regular files/);
    writeFileSync(join(dir, "binary"), Buffer.from([0, 1, 2]));
    expect(() => readSkillTextFile(dir, "binary", 20)).toThrow(/Binary/);
    writeFileSync(join(dir, "invalid"), Buffer.from([0xff]));
    expect(() => readSkillTextFile(dir, "invalid", 20)).toThrow(/encoded data/);
  });

  it("enforces exact byte ceilings, including multibyte text", () => {
    const dir = directory();
    writeFileSync(join(dir, "text"), "é".repeat(512 * 1024));
    expect(readSkillTextFile(dir, "text", 1024 * 1024).bytes).toBe(1024 * 1024);
    expect(() => readSkillTextFile(dir, "text", 1024 * 1024 - 1)).toThrow(/exceeds/);
  });

  it("bounds reads even when a file grows after its size check and always closes the descriptor", () => {
    const dir = directory();
    const file = join(dir, "text");
    writeFileSync(file, "1234");
    vi.mocked(readSync).mockImplementationOnce((...args) => {
      const read = Reflect.apply(actualFs.readSync, actualFs, args);
      appendFileSync(file, "56");
      return read;
    });
    expect(() => readSkillTextFile(dir, "text", 4)).toThrow(/exceeds 4 bytes/);
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it("rejects replacement between metadata check and open and closes the replaced descriptor", () => {
    const dir = directory();
    const file = join(dir, "text");
    writeFileSync(file, "before");
    vi.mocked(openSync).mockImplementationOnce((...args) => {
      renameSync(file, join(dir, "old"));
      writeFileSync(file, "after");
      return Reflect.apply(actualFs.openSync, actualFs, args);
    });
    expect(() => readSkillTextFile(dir, "text", 100)).toThrow(/changed during read/);
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it("rejects a same-inode size change during the read instead of returning unchecked text", () => {
    const dir = directory();
    const file = join(dir, "text");
    writeFileSync(file, "before");
    vi.mocked(readSync).mockImplementationOnce((...args) => {
      const read = Reflect.apply(actualFs.readSync, actualFs, args);
      appendFileSync(file, " changed");
      return read;
    });
    expect(() => readSkillTextFile(dir, "text", 100)).toThrow(/changed during read/);
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it("rejects root and intermediate links/junctions instead of reading outside the bundle", () => {
    const dir = directory();
    const outside = directory();
    writeFileSync(join(outside, "private.txt"), "not a bundle resource");
    symlinkSync(outside, join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() => readSkillTextFile(dir, "linked/private.txt", 100)).toThrow(/symbolic links/);
    expect(() => readSkillTextFile(join(dir, "linked"), "private.txt", 100)).toThrow(/symbolic link/);
  });

  it.skipIf(process.platform === "win32")("rejects a linked leaf file", () => {
    const dir = directory();
    const outside = directory();
    writeFileSync(join(outside, "private"), "not a bundle resource");
    symlinkSync(join(outside, "private"), join(dir, "leaf"));
    expect(() => readSkillTextFile(dir, "leaf", 100)).toThrow(/symbolic links/);
  });
});
