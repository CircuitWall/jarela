import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { classifyRelease, parseVersion, releaseCommitMatchesBase, renderReleaseNotes } from "./nightly-release.mjs";

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

  it("fails explicitly on CI timeout and pins validation and merge to the release head", () => {
    expect(workflow).toContain('select(.head_sha == $sha)');
    expect(workflow).toContain('completed=false');
    expect(workflow).toContain('completed=true');
    expect(workflow).toContain('if [ "$completed" != "true" ]; then');
    expect(workflow).not.toContain("gh pr checks");
    expect(workflow).toContain('--match-head-commit "$HEAD_SHA"');
  });

  it("audits the existing OAuth proxy project rather than a missing directory", () => {
    const publishing = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(publishing).toContain("working-directory: functions/google-oauth-proxy");
    const proxy = JSON.parse(readFileSync(new URL("../functions/google-oauth-proxy/package-lock.json", import.meta.url), "utf8"));
    expect(proxy.lockfileVersion).toBeGreaterThanOrEqual(2);
  });
});

describe("nightly release policy", () => {
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