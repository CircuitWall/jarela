import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { documentationPath, renderDocumentationPrompt, repository, reviewPath, validateRecord, versionOnlyChange } from "./release-docs.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jarela-release-docs-"));
  roots.push(root);
  const git = (...args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", env: { ...process.env, HUSKY: "0" }, stdio: "pipe",
  }).trim();
  const write = (file, value) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  const commit = () => {
    git("add", ".");
    git("-c", "core.hooksPath=", "commit", "-m", "docs(test): update fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-b", "main");
  git("config", "user.name", "Example Maintainer");
  git("config", "user.email", "maintainer@example.test");
  write("package.json", { version: "1.0.0", name: "example" });
  write("package-lock.json", { version: "1.0.0", packages: { "": { version: "1.0.0", name: "example" } } });
  write("README.md", "# Example\n");
  write("source.js", "export const example = 1;\n");
  commit();
  git("tag", "v1.0.0");
  write("source.js", "export const example = 2;\n");
  const source = commit();
  const repo = repository(root);
  const record = {
    schemaVersion: 1, version: "1.0.1", previousTag: "v1.0.0", reviewedSha: source,
    decision: "unnecessary",
    rationale: "This internal implementation change does not alter documented behavior.",
    documentation: [],
  };
  const review = (patch = {}) => {
    write(reviewPath("1.0.1"), { ...record, ...patch });
    return commit();
  };
  return { root, git, write, commit, source, repo, record, review };
}

describe("release documentation records", () => {
  it("accepts only explicit, justified decisions bound to a version and stable tag", () => {
    const { record } = fixture();
    expect(() => validateRecord(record, record)).not.toThrow();
    for (const patch of [
      { schemaVersion: 2 }, { version: "1.0.2" }, { previousTag: "v0.9.0" },
      { reviewedSha: "HEAD" }, { decision: "approved" }, { rationale: "fine" },
      { documentation: ["source.js"] }, { documentation: ["README.md"] },
      { decision: "updated" }, { decision: "updated", documentation: ["README.md", "README.md"] },
    ]) expect(() => validateRecord({ ...record, ...patch }, record)).toThrow();
  });

  it("rejects path traversal and non-documentation output", () => {
    for (const file of ["source.js", ".github/workflows/ci.yml", "docs/../source.md", "docs/releases/1.0.1.json", "docs/.private.md"]) {
      expect(documentationPath(file), file).toBe(false);
    }
    for (const version of ["../1.0.1", "01.0.1", "1.0.1-rc.1", "--help"]) {
      expect(() => reviewPath(version)).toThrow();
    }
  });

  it("requires an existing review instead of silently assuming no docs are needed", () => {
    const { repo } = fixture();
    expect(() => repo.check("1.0.1")).toThrow();
  });

  it("accepts a merged unnecessary decision and documentation-only changes afterwards", () => {
    const { repo, review, write, commit } = fixture();
    review();
    expect(repo.check("1.0.1").decision).toBe("unnecessary");
    write("docs/OPERATIONS.md", "# Operations\n");
    commit();
    expect(() => repo.check("1.0.1")).not.toThrow();
  });

  it("accepts documented changes already included in the source under review", () => {
    const { repo, review, write, commit } = fixture();
    write("README.md", "# Updated behavior\n");
    const source = commit();
    review({ reviewedSha: source, decision: "updated", documentation: ["README.md"] });
    expect(repo.check("1.0.1").decision).toBe("updated");
  });

  it("rejects unchanged, missing, or deleted documentation claimed as updated", () => {
    const { repo, review, write, commit, git } = fixture();
    review({ decision: "updated", documentation: ["README.md"] });
    expect(() => repo.check("1.0.1")).toThrow("not changed");
    write("README.md", "# Changed\n");
    commit();
    expect(() => repo.check("1.0.1")).not.toThrow();
    git("rm", "README.md");
    commit();
    expect(() => repo.check("1.0.1")).toThrow("regular file");
  });

  it("rejects source changes after review, including new commits on an older release base", () => {
    const { repo, review, write, commit } = fixture();
    review();
    write("source.js", "export const example = 3;\n");
    commit();
    expect(() => repo.check("1.0.1")).toThrow("stale");
  });

  it("allows only version changes in package metadata, not dependency or lock changes", () => {
    const { repo, review, write, commit } = fixture();
    review();
    write("package.json", { version: "1.0.1", name: "example" });
    write("package-lock.json", { version: "1.0.1", packages: { "": { version: "1.0.1", name: "example" } } });
    write("CHANGELOG.md", "# Release\n");
    write("docs/adoption/changesets.json", "{}");
    commit();
    expect(() => repo.check("1.0.1")).not.toThrow();
    write("package.json", { version: "1.0.1", name: "example", dependencies: { example: "2.0.0" } });
    commit();
    expect(() => repo.check("1.0.1")).toThrow("stale");
    expect(versionOnlyChange({ version: "1.0.0", dependencies: {} }, { version: "1.0.1", dependencies: { a: "1" } })).toBe(false);
  });

  it("rejects a review from an unrelated commit", () => {
    const { repo, review, git } = fixture();
    git("checkout", "--orphan", "unrelated");
    git("-c", "core.hooksPath=", "commit", "-m", "docs(test): add unrelated root");
    const unrelated = git("rev-parse", "HEAD");
    git("checkout", "main");
    review({ reviewedSha: unrelated });
    expect(() => repo.check("1.0.1")).toThrow();
  });

  it("rejects a stale previous tag and handles a current release tag without using it as its own base", () => {
    const { repo, review, git, write, commit } = fixture();
    review();
    write("package.json", { version: "1.0.1", name: "example" });
    commit();
    git("tag", "v1.0.1");
    expect(repo.context("1.0.1").previousTag).toBe("v1.0.0");
    expect(() => repo.check("1.0.1")).not.toThrow();
    expect(() => repo.context("0.9.0")).toThrow();
    review({ version: "1.0.2" });
    expect(() => repo.check("1.0.1")).toThrow("version");
  });

  it("checks documentation PRs and human-owned version bumps but allows ordinary PRs", () => {
    const { repo, review, source, write, commit } = fixture();
    expect(() => repo.checkPullRequest(source)).not.toThrow();
    review();
    expect(() => repo.checkPullRequest(source)).not.toThrow();
    write("package.json", { version: "1.0.2", name: "example" });
    commit();
    expect(() => repo.checkPullRequest(source)).toThrow();
  });

  it("rejects deletion of a release review in PR CI", () => {
    const { repo, review, git, commit } = fixture();
    const base = review();
    git("rm", "docs/releases/1.0.1.json");
    commit();
    expect(() => repo.checkPullRequest(base)).toThrow();
  });

  it("independently restricts staged and untracked Copilot output to documentation", () => {
    const { repo, record, source, write, git } = fixture();
    write(reviewPath("1.0.1"), record);
    expect(() => repo.checkProposal("1.0.1", source)).not.toThrow();
    write("unexpected.txt", "unexpected");
    expect(() => repo.checkProposal("1.0.1", source)).toThrow("non-documentation");
    git("add", "unexpected.txt");
    expect(() => repo.checkProposal("1.0.1", source)).toThrow("non-documentation");
  });

  it("does not accept a proposal for a different source SHA", () => {
    const { repo, record, source, write } = fixture();
    write(reviewPath("1.0.1"), { ...record, reviewedSha: "0".repeat(40) });
    expect(() => repo.checkProposal("1.0.1", source)).toThrow("requested source");
  });

  it("round-trips the two-job patch handoff through PR CI and a version-matching release tag", () => {
    const { root, repo, record, source, write, git } = fixture();
    write("README.md", "# Documented new behavior\n");
    write(reviewPath("1.0.1"), { ...record, decision: "updated", documentation: ["README.md"] });
    repo.checkProposal("1.0.1", source);
    git("add", ".");
    const patch = git("diff", "--cached", "--binary") + "\n";
    const clone = mkdtempSync(join(tmpdir(), "jarela-docs-patch-consumer-"));
    roots.push(clone);
    execFileSync("git", ["clone", "--quiet", "--no-local", root, clone], { stdio: "pipe" });
    const inClone = (...args) => execFileSync("git", args, { cwd: clone, encoding: "utf8", stdio: "pipe" });
    execFileSync("git", ["apply", "--index", "-"], { cwd: clone, input: patch, stdio: ["pipe", "pipe", "pipe"] });
    const consumer = repository(clone);
    consumer.checkProposal("1.0.1", source);
    const commit = () => inClone(
      "-c", "core.hooksPath=", "-c", "user.name=Example Maintainer",
      "-c", "user.email=maintainer@example.test", "commit", "-m", "docs(test): update fixture",
    );
    commit();
    expect(() => consumer.checkPullRequest(source)).not.toThrow();
    writeFileSync(join(clone, "package.json"), JSON.stringify({ version: "1.0.1", name: "example" }));
    writeFileSync(join(clone, "package-lock.json"), JSON.stringify({
      version: "1.0.1", packages: { "": { version: "1.0.1", name: "example" } },
    }));
    inClone("add", ".");
    commit();
    inClone("tag", "v1.0.1");
    expect(() => consumer.check("1.0.1", "v1.0.1")).not.toThrow();
    expect(() => consumer.checkPullRequest(source)).not.toThrow();
  });
});

describe("on-demand release wiring", () => {
  const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");

  it("runs paid AI only through explicit dispatch with a pinned CLI and session budget", () => {
    const text = workflow("release-docs");
    expect(text).toContain("workflow_dispatch:");
    expect(text).not.toMatch(/^\s*(schedule|push|pull_request|workflow_call):/m);
    expect(text).toContain("@github/copilot@1.0.103");
    expect(text).toContain("--max-ai-credits 50");
    expect(text).toContain("--secret-env-vars=COPILOT_GITHUB_TOKEN");
    expect(text).not.toContain("--allow-all");
    expect(text).not.toContain("gh pr merge");
    expect(text).toContain('node "$RUNNER_TEMP/release-docs-validator.mjs" proposal');
    expect(text).toContain('gh workflow run ci.yml --ref "$BRANCH"');
    expect(workflow("nightly-release")).not.toContain("copilot@");
    expect(workflow("ci")).not.toContain("copilot@");
  });

  it("keeps documentation optional in nightly, PR/manual CI, and tag publishing", () => {
    for (const name of ["nightly-release", "ci", "release"]) {
      expect(workflow(name), name).not.toContain("release-docs.mjs");
      expect(workflow(name), name).not.toContain("COPILOT_DOCS_TOKEN");
    }
    const publishing = workflow("release");
    expect(publishing).toContain('if [ "$GITHUB_REF" != "refs/tags/v$version" ]');
    expect(workflow("nightly-release")).toContain("npm run release:changeset -- --check");
    expect(publishing).toContain("npm run release:changeset -- --check");
    expect(workflow("release-docs")).toContain('node scripts/release-docs.mjs check "$VERSION"');
  });

  it("assembles the exact release context and requires evidence, explicit decisions, and human review", () => {
    const context = { version: "1.0.1", previousTag: "v1.0.0", reviewedSha: "a".repeat(40) };
    const prompt = renderDocumentationPrompt(context);
    expect(prompt).toContain(JSON.stringify(context, null, 2));
    for (const value of ["previousTag to reviewedSha", '"decision": "updated"', '"unnecessary"', "maintainer must review", "report the blocker"]) {
      expect(prompt).toContain(value);
    }
    expect(prompt).not.toMatch(/undefined|NaN|\{\{/);
  });
});
