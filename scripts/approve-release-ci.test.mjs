import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isApprovalCandidate, isTrustedReleasePr } from "./approve-release-ci.mjs";

const context = { repository: "example/project", sha: "a".repeat(40), number: "42", workflowId: 7 };
const pr = {
  number: 42, state: "open", user: { login: "github-actions[bot]", type: "Bot" },
  base: { ref: "main", repo: { full_name: context.repository } },
  head: { ref: "chore/release-1.2.3", sha: context.sha, repo: { full_name: context.repository } },
  body: "<!-- jarela-nightly-release -->",
};
const run = {
  workflow_id: 7, event: "pull_request", conclusion: "action_required", head_sha: context.sha,
  head_repository: { full_name: context.repository }, actor: pr.user,
  pull_requests: [{ number: 42, head: { sha: context.sha, repo: { url: "https://api.github.com/repos/example/project" } } }],
};

describe("scoped release CI approval", () => {
  it("approves workflow execution only after full dispatched validation, before protected merge", () => {
    const workflow = readFileSync(new URL("../.github/workflows/nightly-release.yml", import.meta.url), "utf8");
    const approval = workflow.indexOf("node scripts/approve-release-ci.mjs");
    expect(approval).toBeGreaterThan(workflow.indexOf('if [ "$required_check" -lt 1 ]'));
    expect(approval).toBeLessThan(workflow.indexOf("      - name: Merge release PR"));
    expect(workflow).toContain("PR_NUMBER: ${{ steps.pr.outputs.pr_number }}");
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(ci).toContain("ONNXRUNTIME_NODE_INSTALL: skip");
  });

  it("accepts only the release bot's same-repository exact-head PR", () => {
    expect(isTrustedReleasePr(pr, context)).toBe(true);
    for (const changes of [
      { state: "closed" }, { number: 43 }, { user: { login: "contributor", type: "User" } },
      { body: "unrelated" }, { base: { ...pr.base, ref: "other" } },
      { head: { ...pr.head, sha: "b".repeat(40) } },
      { head: { ...pr.head, repo: { full_name: "other/fork" } } },
      { head: { ...pr.head, ref: "feature/arbitrary" } },
    ]) expect(isTrustedReleasePr({ ...pr, ...changes }, context)).toBe(false);
  });

  it("approves only the exact CI workflow, bot actor, head, and linked PR", () => {
    expect(isApprovalCandidate(run, context)).toBe(true);
    for (const changes of [
      { workflow_id: 8 }, { event: "push" }, { conclusion: "failure" },
      { head_sha: "b".repeat(40) }, { actor: { login: "contributor", type: "User" } },
      { head_repository: { full_name: "other/fork" } }, { pull_requests: [] },
      { pull_requests: [{ number: 43, head: run.pull_requests[0].head }] },
    ]) expect(isApprovalCandidate({ ...run, ...changes }, context)).toBe(false);
  });
});
