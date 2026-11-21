/**
 * Guards the CI trigger itself.
 *
 * A prompt gate is only as good as its path filter: if a prompt source is not
 * in `changes.outputs.prompts`, editing it skips the job and CI stays green
 * while the model receives different text. The registry already knows which
 * files reach the assembled prompt, so the workflow is checked against it
 * instead of against a hand-maintained duplicate.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { SYSTEM_PROMPT_SOURCE_PREFIXES } from "@/lib/agents/prompt-registry";

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index++;
      if (glob[index + 1] === "/") {
        index++;
        out += "(?:.*/)?";
      } else {
        out += ".*";
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function loadWorkflow(name: string): Record<string, any> {
  return parse(readFileSync(join(process.cwd(), ".github", "workflows", name), "utf8"));
}

const ci = loadWorkflow("ci.yml");
const filterStep = ci.jobs.changes.steps.find((step: { id?: string }) => step.id === "filter");
const promptGlobs: string[] = parse(filterStep.with.filters).prompts ?? [];

describe("prompt path filter", () => {
  it("covers every file the prompt registry says reaches the assembled prompt", () => {
    for (const prefix of SYSTEM_PROMPT_SOURCE_PREFIXES) {
      const sample = prefix.endsWith("/") ? `${prefix}sample.ts` : prefix;
      expect(
        matchesAny(promptGlobs, sample),
        `${prefix} changes the agent prompt but is not in the ci.yml "prompts" filter`,
      ).toBe(true);
    }
  });

  it("covers the evaluation harness and the prompt dump script", () => {
    for (const path of [
      "lib/agents/prompt-eval/scenarios.ts",
      "lib/agents/prompt-eval/judge.ts",
      "scripts/dump-prompts.mjs",
      ".github/workflows/ci.yml",
      ".github/workflows/prompt-eval.yml",
    ]) {
      expect(matchesAny(promptGlobs, path), `${path} must trigger the prompt gate`).toBe(true);
    }
  });

  it("does not use a catch-all that would run the gate on every change", () => {
    expect(promptGlobs).not.toContain("**");
    expect(promptGlobs).not.toContain("lib/**");
    expect(promptGlobs).not.toContain("**/*");
  });
});

describe("prompt gate job", () => {
  const job = ci.jobs["prompt-guardrails"];
  const runs = (job?.steps ?? [])
    .map((step: { run?: string }) => step.run ?? "")
    .join("\n");

  it("exists and is driven by the prompts filter", () => {
    expect(job, "ci.yml has no prompt-guardrails job").toBeDefined();
    expect(job.needs).toContain("changes");
    expect(String(job.if)).toContain("needs.changes.outputs.prompts == 'true'");
  });

  it("runs the deterministic prompt suites and dumps the assembled text", () => {
    expect(runs).toContain("npm run test:prompts");
    expect(runs).toContain("npm run prompts:dump");
  });

  it("publishes the assembled prompts for review", () => {
    const upload = (job?.steps ?? []).find(
      (step: { uses?: string }) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact"),
    );
    expect(upload, "prompt artifacts are not uploaded").toBeDefined();
    expect(String(upload.with.path)).toContain(".prompts/");
    // `.prompts/` is hidden; without this the step reports success and uploads
    // nothing, which is exactly how the first version of this job shipped.
    expect(upload.with["include-hidden-files"], "hidden dot-directory would upload nothing").toBe(true);
  });
});

describe("live evaluation workflow", () => {
  const workflow = loadWorkflow("prompt-eval.yml");

  it("is runnable on demand and on prompt-labelled pull requests", () => {
    expect(workflow.on.workflow_dispatch, "prompt-eval.yml needs workflow_dispatch").toBeTruthy();
    const pullRequest = workflow.on.pull_request;
    expect(pullRequest, "prompt-eval.yml needs a pull_request trigger").toBeTruthy();
    expect(pullRequest.types, "a label filter requires the labeled event type").toContain("labeled");
    // `on.pull_request` cannot filter by label, so the job gate must do it.
    expect(String(workflow.jobs.evaluate.if)).toContain("contains(github.event.pull_request.labels.*.name, 'prompt-eval')");
  });

  it("fails forks closed instead of running unkeyed", () => {
    const gate = String(workflow.jobs.evaluate.if);
    expect(gate).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(gate).toContain("prompt-eval");

    // The secret is mapped into env and a preflight step decides whether the
    // suite may run; the `secrets` context is not available in `if:`.
    const env = workflow.jobs.evaluate.env ?? {};
    expect(Object.keys(env).join(" ")).toContain("ANTHROPIC_API_KEY");
    expect(String(env.ANTHROPIC_API_KEY)).toContain("secrets.ANTHROPIC_API_KEY");

    const preflight = (workflow.jobs.evaluate.steps ?? []).find(
      (step: { id?: string }) => step.id === "preflight",
    );
    expect(preflight, "missing credential preflight step").toBeDefined();
    expect(String(preflight.run)).toContain("ready=false");
  });

  it("runs the gated suite and keeps the report", () => {
    const runs = (workflow.jobs.evaluate.steps ?? []).map((step: { run?: string }) => step.run ?? "").join("\n");
    expect(runs).toContain("npm run test:prompt-eval");
    const upload = (workflow.jobs.evaluate.steps ?? []).find(
      (step: { uses?: string }) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact"),
    );
    expect(upload).toBeDefined();
    expect(String(upload.with.path)).toContain(".prompt-eval/");
    expect(upload.with["include-hidden-files"], "hidden dot-directory would upload nothing").toBe(true);
  });
});
