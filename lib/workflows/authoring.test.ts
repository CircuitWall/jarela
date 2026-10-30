import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { scaffoldExtension, prepareContributionBundle } from "./authoring";
import { SECRET_PATTERNS } from "../../scripts/lib/secret-patterns.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp() { const path = mkdtempSync(join(tmpdir(), "jarela-authoring & fixture-")); roots.push(path); return path; }
const scaffold = () => ({ name: "fixture_echo", goal: "Read a value from a synthetic service",
  discovery: { decision: "author", evidence: "Existing catalog has no fixture echo operation" } });
const contribution = () => ({
  destination: "example/fixture", branch: "feat/fixture-echo", base_revision: "a".repeat(40),
  classification: "extension", summary: "Add synthetic echo fixture", ownership: "user_owned",
  license_review: "Synthetic original fixture; destination permits this contribution",
  worktree: "clean", tests: { status: "passed", command: "node --test fixture_echo.test.cjs", evidence: "Synthetic fixture passed" },
  files: [{ path: "fixture.txt", before: "old\n", after: "new\n" }],
});

describe("inert extension authoring", () => {
  it("returns deterministic bounded artifact text without any filesystem writes or execution authority", () => {
    const root = temp(), before = readdirSync(root);
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = scaffoldExtension(scaffold());
      expect(result).toEqual(scaffoldExtension(scaffold()));
      expect(result).toMatchObject({
        ok: true, scope: "local_synthetic_service_template", relative_staging_directory: "extension-drafts/fixture_echo",
        execution_authorized: false, installation_authorized: false, publication_authorized: false,
        validation: { status: "not_run", runtime: "process.execPath" },
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32768);
    }
    expect(readdirSync(root)).toEqual(before);
  });

  it("executes generated tests only in the explicitly invoked test fixture, outside autoload directories", () => {
    const result = scaffoldExtension(scaffold());
    if (!result.ok) throw new Error("Expected scaffold");
    const root = temp();
    for (const file of result.files) writeFileSync(join(root, file.path), file.content);
    const child = spawnSync(process.execPath, result.validation.argv, { cwd: root, env: {}, encoding: "utf8", timeout: 10000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stdout).toMatch(/pass 1/);
    expect(child.stderr).toBe("");
  });

  it.each([
    { ...scaffold(), name: "../tools" }, { ...scaffold(), name: "bad-name" },
    { ...scaffold(), discovery: { decision: "reuse", evidence: "Already installed" } },
    { ...scaffold(), discovery: { decision: "configure", evidence: "Missing setup" } },
    { ...scaffold(), goal: "x".repeat(2001) }, { ...scaffold(), activate: true },
    { ...scaffold(), goal: "   " }, { ...scaffold(), goal: "\ud800" },
  ])("rejects malformed, oversized or non-authoring scope", (input) => {
    expect(scaffoldExtension(input)).toMatchObject({ ok: false, execution_authorized: false });
  });

  it("invalidates the revision when the scope or discovery evidence changes", () => {
    const first = scaffoldExtension(scaffold()), second = scaffoldExtension({ ...scaffold(), goal: "A different authorized goal" });
    if (!first.ok || !second.ok) throw new Error("Expected scaffolds");
    expect(first.revision).not.toBe(second.revision);
  });
});

describe("local contribution review bundle", () => {
  it("produces 10/10 deterministic exact diffs with no network, execution or publication authority", () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = prepareContributionBundle(contribution());
      expect(result).toEqual(prepareContributionBundle(contribution()));
      expect(result).toMatchObject({
        ok: true, kind: "local_contribution_review_bundle", publication_authorized: false, execution_authorized: false,
        checks: { scope: "supplied_text_only", tests: "caller_supplied_not_verified", privacy: "heuristics_passed_human_review_required" },
      });
    }
  });

  it.each([
    ["old\n", "new\n"], ["old", "new"], [null, "new\n"], ["old\n", null],
    ["", "new\n"], ["old\n", ""], ["one\r\ntwo\r\n", "new\r\n"], ["\n", "new\n"],
  ] as const)("builds a git-applicable exact patch for before=%s after=%s", (before, after) => {
    const result = prepareContributionBundle({ ...contribution(), files: [{ path: "nested/fixture.txt", before, after }] });
    if (!result.ok) throw new Error("Expected bundle");
    const root = temp(), path = join(root, "nested", "fixture.txt");
    mkdirSync(dirname(path), { recursive: true });
    if (before !== null) writeFileSync(path, before);
    const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
    expect(init.status).toBe(0);
    const apply = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "-"], { input: result.diff, cwd: root, encoding: "utf8" });
    expect(apply.status, apply.stderr).toBe(0);
    if (after === null) expect(existsSync(path)).toBe(false);
    else expect(readFileSync(path, "utf8")).toBe(after);
  });

  it.each([
    { worktree: "dirty" }, { worktree: "unknown" }, { ownership: "unknown" },
    { tests: { status: "failed", command: "node --test", evidence: "Failed" } },
    { tests: { status: "not_run", command: "node --test", evidence: "Not run" } },
    { branch: "main" }, { destination: "https://example.invalid/repo" }, { publish: true }, { base_revision: "a".repeat(41) },
    { files: [{ path: "../escape.txt", before: null, after: "new" }] },
    { files: [{ path: "fixture.txt", before: "same", after: "same" }] },
    { files: [{ path: "fixture.txt", before: null, after: "" }] },
    { files: [{ path: ".env.local", before: null, after: "value" }] },
    { files: [{ path: "chats/private.md", before: null, after: "value" }] },
    { files: [{ path: "Fixture.txt", before: null, after: "a" }, { path: "fixture.txt", before: null, after: "b" }] },
    { files: [{ path: "fixture", before: null, after: "a" }, { path: "Fixture/nested.txt", before: null, after: "b" }] },
    { files: [{ path: "fixture.txt", before: null, after: "\0" }] },
    { files: [{ path: "fixture.txt", before: null, after: "\ud800" }] },
    { files: [{ path: "fixture.txt", before: null, after: "x".repeat(16385) }] },
  ])("blocks invalid scope rather than producing a publishable bundle: %j", (override) => {
    const result = prepareContributionBundle({ ...contribution(), ...override });
    expect(result).toMatchObject({ ok: false, publication_authorized: false });
    expect(result).not.toHaveProperty("files");
    expect(result).not.toHaveProperty("diff");
  });

  it("bounds aggregate input bytes, not just individual file characters", () => {
    const files = Array.from({ length: 10 }, (_, index) => ({ path: `fixture${index}.txt`, before: null, after: "x".repeat(10000) }));
    expect(prepareContributionBundle({ ...contribution(), files })).toMatchObject({ ok: false, issues: [{ message: "Input exceeds 64 KiB" }] });
  });

  it.each([
    "ghp_" + "a".repeat(36), "xoxb-" + "0".repeat(20), "GOCSPX-" + "a".repeat(24),
    "password=not-a-real-password", "person@example.invalid", "C:\\Users\\fixture\\private",
    "/home/fixture/private", "github_pat_" + "a".repeat(40),
  ])("does not echo detected sensitive data or permit suppression", (content) => {
    const result = prepareContributionBundle({ ...contribution(), files: [{ path: "fixture.txt", before: null, after: `${content} // nosecret` }] });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(content);
    expect(scaffoldExtension({ ...scaffold(), goal: content })).toMatchObject({ ok: false });
  });

  it("sorts file paths stably and binds all reviewed metadata and bytes to the revision", () => {
    const files = [{ path: "z.txt", before: null, after: "z\n" }, { path: "a.txt", before: null, after: "a\n" }];
    const first = prepareContributionBundle({ ...contribution(), files });
    const reversed = prepareContributionBundle({ ...contribution(), files: [...files].reverse() });
    expect(first).toEqual(reversed);
    if (!first.ok) throw new Error("Expected bundle");
    for (const changed of [{ destination: "example/other" }, { base_revision: "b".repeat(40) }, { branch: "fix/other" },
      { tests: { ...contribution().tests, evidence: "Different evidence" } }, { files: [{ ...files[0], after: "changed\n" }] }]) {
      const next = prepareContributionBundle({ ...contribution(), files, ...changed });
      if (!next.ok) throw new Error("Expected changed bundle");
      expect(next.revision).not.toBe(first.revision);
    }
    expect(SECRET_PATTERNS.length).toBeGreaterThan(10);
  });

  it("does not echo an unknown field name containing sensitive content", () => {
    const content = "ghp_" + "a".repeat(36);
    const result = prepareContributionBundle({ ...contribution(), [content]: "untrusted" });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(content);
  });

  it("preserves CLI secret-scanner matching and inline suppression after sharing its patterns", () => {
    const path = join(temp(), "fixture.txt");
    const content = "ghp_" + "a".repeat(36);
    const scanner = resolve("scripts", "scan-secrets.mjs");
    writeFileSync(path, content);
    const blocked = spawnSync(process.execPath, [scanner, path], { encoding: "utf8", timeout: 10000 });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("GitHub PAT (classic)");
    writeFileSync(path, `${content} // nosecret`);
    const suppressed = spawnSync(process.execPath, [scanner, path], { encoding: "utf8", timeout: 10000 });
    expect(suppressed.status).toBe(0);
    expect(suppressed.stdout).toContain("clean (1 files)");
    expect(prepareContributionBundle({ ...contribution(), summary: `${content} // nosecret` })).toMatchObject({ ok: false });
  });
});
