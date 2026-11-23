import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";

export function isTrustedReleasePr(pr, { repository, sha, number }) {
  return pr.number === Number(number) && pr.state === "open"
    && pr.user?.login === "github-actions[bot]" && pr.user.type === "Bot"
    && pr.base?.ref === "main" && pr.base.repo?.full_name === repository
    && pr.head?.repo?.full_name === repository && pr.head.sha === sha
    && /^chore\/release-\d+\.\d+\.\d+$/.test(pr.head.ref)
    && pr.body?.includes("<!-- jarela-nightly-release -->");
}

export function isApprovalCandidate(run, { repository, sha, number, workflowId }) {
  return run.workflow_id === workflowId && run.event === "pull_request"
    && run.conclusion === "action_required" && run.head_sha === sha
    && run.head_repository?.full_name === repository
    && run.actor?.login === "github-actions[bot]" && run.actor.type === "Bot"
    && run.pull_requests?.some((pr) => pr.number === Number(number)
      && pr.head.sha === sha && pr.head.repo?.url === `https://api.github.com/repos/${repository}`);
}

// GitHub reports the pre-approval attempt as completed/action_required until the
// approved attempt is actually queued, so that state is not a final conclusion.
export const APPROVAL_SETTLE_MS = 180_000;

export function isAwaitingApprovalStart(run, elapsedMs) {
  return run.status === "completed" && run.conclusion === "action_required"
    && elapsedMs < APPROVAL_SETTLE_MS;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_REPOSITORY: repository, HEAD_SHA: sha, PR_NUMBER: number } = process.env;
  if (!repository || !/^[a-f0-9]{40}$/.test(sha ?? "") || !/^\d+$/.test(number ?? "")) {
    throw new Error("Expected repository, exact release HEAD_SHA, and PR_NUMBER");
  }
  const api = (endpoint, method = "GET") => {
    const result = execFileSync("gh", ["api", "--method", method, endpoint], { encoding: "utf8" });
    return result.trim() ? JSON.parse(result) : null;
  };
  const context = { repository, sha, number };
  const pr = api(`repos/${repository}/pulls/${number}`);
  if (!isTrustedReleasePr(pr, context)) throw new Error("Release PR identity changed; refusing CI approval");
  const workflow = api(`repos/${repository}/actions/workflows/ci.yml`);
  const runs = api(`repos/${repository}/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${sha}&per_page=100`);
  for (const run of runs.workflow_runs) {
    if (!isApprovalCandidate(run, { ...context, workflowId: workflow.id })) continue;
    const current = api(`repos/${repository}/pulls/${number}`);
    if (!isTrustedReleasePr(current, context)) throw new Error("Release PR changed before CI approval");
    api(`repos/${repository}/actions/runs/${run.id}/approve`, "POST");
    console.log(`Approved CI run ${run.id} for verified release PR #${number} at ${sha}`);
    const approvedAt = Date.now();
    let complete = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      const result = api(`repos/${repository}/actions/runs/${run.id}`);
      if (result.status === "completed" && !isAwaitingApprovalStart(result, Date.now() - approvedAt)) {
        if (result.conclusion === "action_required") {
          throw new Error(`Approval did not start release CI run ${run.id} within ${APPROVAL_SETTLE_MS / 1000}s`);
        }
        if (result.conclusion !== "success") throw new Error(`Approved release CI concluded ${result.conclusion}`);
        complete = true;
        break;
      }
      await setTimeout(10_000);
    }
    if (!complete) throw new Error(`Timed out waiting for approved release CI run ${run.id}`);
  }
}
