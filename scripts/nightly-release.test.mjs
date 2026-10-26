import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRelease, parseCommitLog, parseVersion, releaseCommitMatchesBase, renderReleaseNotes } from "./nightly-release.mjs";

function commit(subject, body = "", sha = "sha") {
  return { subject, body, sha };
}

describe("nightly workflow defaults", () => {
  const workflow = readFileSync(new URL("../.github/workflows/nightly-release.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

  it("publishes by default on manual dispatch and retains the nightly schedule", () => {
    expect(workflow).toMatch(/dry_run:\s*\n\s+description:.*\n\s+required: false\s*\n\s+type: boolean\s*\n\s+default: false/);
    expect(workflow).toContain('- cron: "0 3 * * *"');
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
  });

  it("keeps explicit dry runs from entering the release and recovery paths", () => {
    const steps = workflow.split("      - name: ");
    const guard = "(github.event_name != 'workflow_dispatch' || !inputs.dry_run)";
    for (const name of [
      "Recover a failed release for the latest tag",
      "Check for an existing nightly release PR",
      "Verify changeset for a resumed release",
      "Tag and dispatch the release workflow",
    ]) {
      const step = steps.find((text) => text.startsWith(`${name}\n`));
      expect(step, name).toBeDefined();
      expect(step.split("\n").find((line) => line.trimStart().startsWith("if:")), name).toContain(guard);
    }
    const dryRun = steps.find((text) => text.startsWith("Describe dry-run plan\n"));
    expect(dryRun).toContain("if: github.event_name == 'workflow_dispatch' && inputs.dry_run");
  });

  it("uses explicit GET for filtered GitHub API reads instead of implicit POST", () => {
    const filteredReads = workflow.split("\n").filter((line) => line.includes("gh api") && / -[fF] /.test(line));
    expect(filteredReads).toHaveLength(3);
    for (const line of filteredReads) expect(line).toContain("gh api --method GET");
    expect(workflow).toContain('/actions/runs/$run_id/jobs" -f filter=latest');
    expect(workflow).not.toContain("check-runs?");
  });

  it("can reuse both GitHub Actions author representations but requires bot identity", () => {
    expect(workflow).toContain('.[0].author.is_bot // false');
    expect(workflow).toContain('"$is_bot" != "true"');
    expect(workflow).toContain('"$author" != "github-actions[bot]" && "$author" != "app/github-actions"');
    expect(workflow).toContain("<!-- jarela-nightly-release -->");
    expect(workflow).toContain('commit_count" != "1"');
  });

  it("finds release PRs with the supported branch-only head filter and excludes forks", () => {
    expect(workflow).toContain('--head "$branch" --state open');
    expect(workflow).not.toContain('--head "$GITHUB_REPOSITORY_OWNER:$branch"');
    expect(workflow).toContain("select(.isCrossRepository == false)");
  });

  it("fails explicitly on CI timeout and pins validation and merge to the release head", () => {
    expect(workflow).toContain('select(.head_sha == $sha)');
    expect(workflow).toContain('completed=false');
    expect(workflow).toContain('completed=true');
    expect(workflow).toContain('if [ "$completed" != "true" ]; then');
    expect(workflow).not.toContain("gh pr checks");
    expect(workflow).toContain('--match-head-commit "$HEAD_SHA"');
  });

  it("validates the resumed release at its exact commit with matching dependencies", () => {
    const step = workflow.split("      - name: ").find((text) => text.startsWith("Verify changeset for a resumed release\n"));
    expect(step).toContain("TARGET_SHA: ${{ steps.plan.outputs.target_sha }}");
    expect(step).toMatch(/git switch --detach "\$TARGET_SHA"\n\s+npm ci[^\n]*\n\s+npm run release:changeset -- --check/);
  });

  it("accepts only content-identical base drift after merging a release", () => {
    expect(workflow).toContain('"$merge_parent" != "$PLANNED_MAIN_SHA"');
    expect(workflow).toContain('git rev-parse "$merge_parent^{tree}"');
    expect(workflow).toContain('git rev-parse "$PLANNED_MAIN_SHA^{tree}"');
    expect(workflow).not.toContain('name: Hold breaking changes for a human release');
    expect(workflow).toContain('The release planner held publication ($REASON)');
  });

  it("audits the existing OAuth proxy project rather than a missing directory", () => {
    const publishing = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(publishing).toContain("working-directory: functions/google-oauth-proxy");
    const proxy = JSON.parse(readFileSync(new URL("../functions/google-oauth-proxy/package-lock.json", import.meta.url), "utf8"));
    expect(proxy.lockfileVersion).toBeGreaterThanOrEqual(2);
  });
});

describe("nightly release policy", () => {
  it.each(["\n", "\r\n"])("parses git log record newlines without contaminating recovery revisions (%j)", (newline) => {
    const base = "0123456789abcdef0123456789abcdef01234567";
    const release = "abcdef0123456789abcdef0123456789abcdef01";
    const commits = parseCommitLog(
      `${base}\x1ffix(chat): improve history\x1f\x1e${newline}`
      + `${release}\x1fchore(release): bump to 2.5.4\x1fRelease base: ${base}${newline}\x1e${newline}`,
    );
    expect(commits).toEqual([
      commit("fix(chat): improve history", "", base),
      commit("chore(release): bump to 2.5.4", `Release base: ${base}`, release),
    ]);
    expect(classifyRelease({ currentVersion: "2.5.4", latestTag: "v2.5.3", commits }))
      .toMatchObject({ action: "resume", targetSha: release });
    expect(releaseCommitMatchesBase(commits[1], base)).toBe(true);
  });

  it("ignores empty git log records", () => {
    expect(parseCommitLog("\n\x1e\r\n")).toEqual([]);
  });

  it("preserves the current tag when there are no unreleased commits", () => {
    expect(classifyRelease({ currentVersion: "2.5.3", latestTag: "v2.5.3", commits: [] }))
      .toMatchObject({ action: "none", version: "2.5.3", latestTag: "v2.5.3" });
  });

  it("uses patch releases for fewer than three feat commits", () => {
    const plan = classifyRelease({
      currentVersion: "2.5.3",
      latestTag: "v2.5.3",
      commits: [commit("feat(chat): add a small capability"), commit("fix(ui): correct a layout")],
    });

    expect(plan).toMatchObject({ action: "release", bump: "patch", version: "2.5.4", featureCount: 1 });
  });

  it("uses a minor release for three or more feat commits", () => {
    const plan = classifyRelease({
      currentVersion: "2.5.3",
      latestTag: "v2.5.3",
      commits: [
        commit("feat(chat): add one"),
        commit("feat(dashboard): add two"),
        commit("feat(memory): add three"),
        commit("fix(ui): correct a layout"),
      ],
    });

    expect(plan).toMatchObject({ action: "release", bump: "minor", version: "2.6.0", featureCount: 3 });
  });

  it("holds breaking commits for a human instead of auto-releasing a major", () => {
    const subjectBreaking = classifyRelease({
      currentVersion: "2.5.3",
      latestTag: "v2.5.3",
      commits: [commit("feat(api)!: break a contract")],
    });
    const footerBreaking = classifyRelease({
      currentVersion: "2.5.3",
      latestTag: "v2.5.3",
      commits: [commit("fix(api): change a contract", "BREAKING CHANGE: clients must migrate")],
    });

    expect(subjectBreaking).toMatchObject({ action: "manual", reason: "breaking-change" });
    expect(footerBreaking).toMatchObject({ action: "manual", reason: "breaking-change" });
  });

  it("keeps independently versioned workspace package breaks out of app release classification", () => {
    const plan = classifyRelease({
      currentVersion: "2.5.3",
      latestTag: "v2.5.3",
      commits: [
        commit(
          "build(packages)!: require Node 24",
          "BREAKING CHANGE: workspace packages now require Node 24.15.0+ or 26.0.0+",
        ),
      ],
    });

    expect(plan).toMatchObject({ action: "release", bump: "patch", version: "2.5.4" });
  });

  it("resumes a merged release commit whose tag push did not complete", () => {
    const plan = classifyRelease({
      currentVersion: "2.5.4",
      latestTag: "v2.5.3",
      commits: [commit("fix(chat): improve history", "", "fix-sha"), commit("chore(release): bump to 2.5.4", "Release base: 0123456789abcdef0123456789abcdef01234567", "release-sha")],
    });

    expect(plan).toMatchObject({ action: "resume", version: "2.5.4", targetSha: "release-sha" });
  });

  it("rejects recovery when the release commit was rebased onto an unrecorded main base", () => {
    const base = "0123456789abcdef0123456789abcdef01234567";
    const commitWithBase = commit("chore(release): bump to 2.5.4", `Release base: ${base}`);

    expect(releaseCommitMatchesBase(commitWithBase, base)).toBe(true);
    expect(releaseCommitMatchesBase(commitWithBase, "abcdef0123456789abcdef0123456789abcdef01")).toBe(false);
    expect(releaseCommitMatchesBase(commit("chore(release): bump to 2.5.4"), base)).toBe(false);
  });

  it("recovers a rebased release only when both base trees are identical", () => {
    const base = "0123456789abcdef0123456789abcdef01234567";
    const parent = "abcdef0123456789abcdef0123456789abcdef01";
    const release = commit("chore(release): bump to 2.5.4", `Release base: ${base}`);
    const sameTree = () => "identical-tree";
    const differentTrees = (ref) => ref === base ? "original-tree" : "changed-tree";

    expect(releaseCommitMatchesBase(release, parent, sameTree)).toBe(true);
    expect(releaseCommitMatchesBase(release, parent, differentTrees)).toBe(false);
    expect(releaseCommitMatchesBase(commit("chore(release): bump to 2.5.4"), parent, sameTree)).toBe(false);
    expect(() => releaseCommitMatchesBase(release, parent, () => {
      throw new Error("Missing release base object");
    })).toThrow("Missing release base object");
  });

  it.each([false, true])("checks real Git tree contents before recovery (changed base: %s)", (changedBase) => {
    const root = mkdtempSync(join(tmpdir(), "jarela-release-recovery-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Release Test");
      git("config", "user.email", "release-test@example.invalid");
      writeFileSync(join(root, "package.json"), '{"version":"2.5.3"}\n');
      git("add", "package.json");
      git("commit", "-m", "chore(test): initialize release");
      git("tag", "v2.5.3");
      const base = git("rev-parse", "HEAD");
      if (changedBase) {
        writeFileSync(join(root, "source.txt"), "new source content\n");
        git("add", "source.txt");
      }
      git("commit", "--allow-empty", "-m", "chore(test): advance release base");
      writeFileSync(join(root, "package.json"), '{"version":"2.5.4"}\n');
      git("add", "package.json");
      git("commit", "-m", "chore(release): bump to 2.5.4", "-m", `Release base: ${base}`);
      const releaseSha = git("rev-parse", "HEAD");
      git("commit", "--allow-empty", "-m", "fix(test): later main change");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      const output = execFileSync(process.execPath, [fileURLToPath(new URL("./nightly-release.mjs", import.meta.url)), "plan"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
      });
      expect(output).toContain(changedBase ? "action=manual\n" : "action=resume\n");
      expect(output).toContain(changedBase ? "reason=release-base-advanced\n" : `target_sha=${releaseSha}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("formats conventional commits into release notes", () => {
    expect(renderReleaseNotes([
      commit("feat(dashboard): add cost chart"),
      commit("fix(chat): prevent blank history"),
      commit("test(ui): cover loading state"),
    ])).toBe([
      "### Added",
      "",
      "- dashboard: Add cost chart",
      "",
      "### Fixed",
      "",
      "- chat: Prevent blank history",
      "",
      "### Changed",
      "",
      "- ui: Cover loading state",
    ].join("\n"));
  });

  it("rejects non-stable version inputs", () => {
    expect(() => parseVersion("2.5.3-rc.1")).toThrow("Invalid stable semver version");
  });
});