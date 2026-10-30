import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillExecutionArtifact } from "./execution-artifact";
import { SKILL_INSPECTION_LIMITS } from "./execution-manifest";
import * as bundleFiles from "./bundle-files";

const dirs: string[] = [];
function bundle(override = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jarela-artifact-"));
  dirs.push(dir);
  writeFileSync(join(dir, "SKILL.md"), "# Example\nInert capture fixture.");
  writeFileSync(join(dir, "entry.mjs"), 'throw new Error("Capture must never execute me");');
  writeFileSync(join(dir, "execution.json"), JSON.stringify({
    schemaVersion: 1, entrypoint: "entry.mjs", files: ["entry.mjs"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "null" }, ...override,
  }));
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("inert in-memory skill artifacts", () => {
  it("constructs exact bounded text artifacts without filesystem writes or execution", () => {
    const dir = bundle();
    const captured = SkillExecutionArtifact.capture(dir);
    const files = captured.files.map(({ path }) => ({ path, content: captured.readFile(path).toString("utf8") }));
    expect(SkillExecutionArtifact.fromFiles([...files].reverse()).revision).toBe(captured.revision);
    const artifact = SkillExecutionArtifact.fromFiles(files);
    files[0].content = "changed";
    expect(artifact.revision).toBe(captured.revision);
    expect(() => SkillExecutionArtifact.fromFiles(files.slice(1))).toThrow();
    expect(() => SkillExecutionArtifact.fromFiles([...files, { path: "extra.txt", content: "extra" }])).toThrow(/exactly/);
    expect(() => SkillExecutionArtifact.fromFiles([...files, { path: "skill.md", content: "duplicate" }])).toThrow(/Duplicate/);
    expect(() => SkillExecutionArtifact.fromFiles([...files, { path: "../escape", content: "" }])).toThrow();
    expect(() => SkillExecutionArtifact.fromFiles([...files, { path: "bad.txt", content: "\ud800" }])).toThrow(/UTF-8/);
    expect(() => SkillExecutionArtifact.fromFiles([...files, { path: "entry.mjs/nested", content: "" }])).toThrow(/Conflicting/);
  });
  it("captures exact instructions, manifest and declared binary assets without running code", () => {
    const dir = bundle({ files: ["entry.mjs", "assets/data.bin"] });
    mkdirSync(join(dir, "assets"));
    const binary = Buffer.from([0, 255, 128, 10]);
    writeFileSync(join(dir, "assets", "data.bin"), binary);
    writeFileSync(join(dir, "not-declared.txt"), "not captured");
    const artifact = SkillExecutionArtifact.capture(dir);
    expect(artifact.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.files.map((file) => file.path)).toEqual(["SKILL.md", "assets/data.bin", "entry.mjs", "execution.json"]);
    expect(artifact.totalBytes).toBe(artifact.files.reduce((sum, file) => sum + file.bytes, 0));
    expect(artifact.readFile("assets/data.bin")).toEqual(binary);
    expect(() => artifact.readFile("not-declared.txt")).toThrow(/not part/);
    expect(() => artifact.readFile("../entry.mjs")).toThrow();
  });

  it("is content-stable across source locations and independent of later edits or deletion", () => {
    const first = bundle();
    const second = bundle();
    const artifact = SkillExecutionArtifact.capture(first);
    expect(SkillExecutionArtifact.capture(second).revision).toBe(artifact.revision);
    const original = artifact.readFile("entry.mjs");
    writeFileSync(join(first, "entry.mjs"), "changed");
    expect(SkillExecutionArtifact.capture(first).revision).not.toBe(artifact.revision);
    expect(artifact.readFile("entry.mjs")).toEqual(original);
    rmSync(join(first, "entry.mjs"));
    expect(artifact.readFile("entry.mjs")).toEqual(original);
  });

  it("returns defensive bytes and fresh manifests with frozen metadata", () => {
    const artifact = SkillExecutionArtifact.capture(bundle());
    const bytes = artifact.readFile("entry.mjs");
    bytes.fill(0);
    expect(artifact.readFile("entry.mjs").equals(bytes)).toBe(false);
    const manifest = artifact.getManifest();
    manifest.files.push("injected.mjs");
    manifest.timeoutMs = 1000;
    expect(artifact.getManifest().files).toEqual(["entry.mjs"]);
    expect(artifact.getManifest().timeoutMs).toBe(60000);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.files)).toBe(true);
    expect(Object.isFrozen(artifact.files[0])).toBe(true);
  });

  it("supports portable paths with spaces and captures no more than the declared file-count limit", () => {
    const files = ["entry.mjs", ...Array.from({ length: 63 }, (_, index) => `assets with spaces/${index}.bin`)];
    const dir = bundle({ files });
    mkdirSync(join(dir, "assets with spaces"));
    for (let index = 0; index < 63; index++) writeFileSync(join(dir, "assets with spaces", `${index}.bin`), Buffer.from([index]));
    const artifact = SkillExecutionArtifact.capture(dir);
    expect(artifact.files).toHaveLength(66);
    expect(artifact.readFile("assets with spaces/62.bin")).toEqual(Buffer.from([62]));
  });

  it.each(["SKILL.md", "execution.json", "entry.mjs"])("binds changes in %s to a new revision", (path) => {
    const dir = bundle();
    const before = SkillExecutionArtifact.capture(dir);
    writeFileSync(join(dir, path), Buffer.concat([before.readFile(path), Buffer.from("\n")]));
    expect(SkillExecutionArtifact.capture(dir).revision).not.toBe(before.revision);
  });

  it("counts reserved metadata once when explicitly declared and rejects case aliases", () => {
    const artifact = SkillExecutionArtifact.capture(bundle({ files: ["entry.mjs", "SKILL.md", "execution.json"] }));
    expect(artifact.files).toHaveLength(3);
    expect(() => SkillExecutionArtifact.capture(bundle({ files: ["entry.mjs", "skill.md"] }))).toThrow(/exact reserved spelling/);
  });

  it("rejects absent instructions and invalid UTF-8 or malformed manifests", () => {
    const dir = bundle();
    rmSync(join(dir, "SKILL.md"));
    expect(() => SkillExecutionArtifact.capture(dir)).toThrow();
    writeFileSync(join(dir, "SKILL.md"), "instructions");
    writeFileSync(join(dir, "execution.json"), Buffer.from([255]));
    expect(() => SkillExecutionArtifact.capture(dir)).toThrow();
    writeFileSync(join(dir, "execution.json"), "{}");
    expect(() => SkillExecutionArtifact.capture(dir)).toThrow();
    writeFileSync(join(dir, "execution.json"), " ".repeat(SKILL_INSPECTION_LIMITS.manifestBytes + 1));
    expect(() => SkillExecutionArtifact.capture(dir)).toThrow(/File exceeds/);
  });

  it("rejects missing declared files and directories in place of regular files", () => {
    const dir = bundle({ files: ["entry.mjs", "missing.txt"] });
    expect(() => SkillExecutionArtifact.capture(dir)).toThrow();
    mkdirSync(join(dir, "missing.txt"));
    expect(() => SkillExecutionArtifact.capture(dir)).toThrow(/regular files/);
  });

  it("enforces individual and total captured byte bounds including manifest and instructions", () => {
    const dir = bundle({ files: ["entry.mjs", "a.bin", "b.bin", "c.bin"] });
    for (const file of ["a.bin", "b.bin", "c.bin"]) writeFileSync(join(dir, file), Buffer.alloc(SKILL_INSPECTION_LIMITS.fileBytes));
    const initial = SkillExecutionArtifact.capture(dir);
    const overhead = initial.totalBytes - 3 * SKILL_INSPECTION_LIMITS.fileBytes - initial.readFile("SKILL.md").length;
    writeFileSync(join(dir, "SKILL.md"), Buffer.alloc(SKILL_INSPECTION_LIMITS.fileBytes - overhead));
    expect(SkillExecutionArtifact.capture(dir).totalBytes).toBe(SKILL_INSPECTION_LIMITS.totalBytes);
    writeFileSync(join(dir, "SKILL.md"), Buffer.alloc(SKILL_INSPECTION_LIMITS.fileBytes - overhead + 1));
    expect(() => SkillExecutionArtifact.capture(dir)).toThrow(/4 MiB including metadata/);
    writeFileSync(join(dir, "SKILL.md"), Buffer.alloc(SKILL_INSPECTION_LIMITS.fileBytes + 1));
    expect(() => SkillExecutionArtifact.capture(dir)).toThrow(/File exceeds/);
  });

  it("rejects symlinked roots and declared directories without following them", () => {
    const dir = bundle({ files: ["entry.mjs", "linked/data.txt"] });
    const outside = bundle();
    writeFileSync(join(outside, "data.txt"), "outside");
    symlinkSync(outside, join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() => SkillExecutionArtifact.capture(dir)).toThrow(/without symbolic links/);
    const alias = join(dir, "alias");
    symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => SkillExecutionArtifact.capture(alias)).toThrow(/must not be a symbolic link/);
  });

  it("detects source mutation between capture and the verification pass", () => {
    const dir = bundle();
    const read = bundleFiles.readSkillFileBytes;
    let changed = false;
    vi.spyOn(bundleFiles, "readSkillFileBytes").mockImplementation((root, path, max) => {
      const bytes = read(root, path, max);
      if (path === "entry.mjs" && !changed) {
        changed = true;
        writeFileSync(join(root, "entry.mjs"), "changed after capture");
      }
      return bytes;
    });
    expect(() => SkillExecutionArtifact.capture(dir)).toThrow(/source changed/);
  });
});
