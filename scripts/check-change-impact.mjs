#!/usr/bin/env node
// Advisory ripple-effect audit for Jarela changes. Compares two git refs (or
// staged changes) and prints follow-up surfaces that commonly need updates when
// tools, scheduler behavior, instructions, skills, persistence, APIs, or package
// metadata change.
//
// Usage:
//   node scripts/check-change-impact.mjs
//   node scripts/check-change-impact.mjs --base origin/main --head HEAD
//   node scripts/check-change-impact.mjs --base v1.29.4 --head origin/main
//   node scripts/check-change-impact.mjs --staged
//   node scripts/check-change-impact.mjs --json
//   node scripts/check-change-impact.mjs --fail-on-warnings
//
// Default range:
//   - on a topic branch: merge-base(origin/main, HEAD)..HEAD
//   - on main/master: latest tag..HEAD

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const RULES = [
  {
    id: "tool-surface",
    title: "Tool surface changed",
    patterns: [
      /^lib\/tools\/.+\.ts$/,
      /^packages\/[^/]+-langchain\/src\/.+\.ts$/,
      /^lib\/integrations\/.+\/manifest\.ts$/,
    ],
    followUps: [
      "Update or verify tool descriptions so agents choose the most specific typed tool before shell commands.",
      "Check capability/category registration, default package descriptors, and permission expectations.",
      "Add focused tool tests and a list_tools/catalog assertion when selection guidance changes.",
      "If behavior is user-visible, update README, package docs, or CHANGELOG.",
    ],
  },
  {
    id: "scheduler-trigger",
    title: "Scheduler or trigger behavior changed",
    patterns: [
      /^lib\/scheduler\//,
      /^lib\/triggers\//,
      /^lib\/tools\/(schedule|watcher)\.ts$/,
    ],
    followUps: [
      "Check scheduled-task and watcher tests for duplicate, retry, idempotency, and missed-event behavior.",
      "Update agent instructions or skills if agents need a different scheduling workflow.",
      "Update ADRs/docs when cadence, persistence, or background execution semantics change.",
    ],
  },
  {
    id: "agent-prompt",
    title: "Agent prompt or runtime policy changed",
    patterns: [
      /^lib\/agents\//,
      /^lib\/agents\/prepare\/system-prompt\.ts$/,
      /^lib\/agents\/harness\//,
    ],
    followUps: [
      "Run focused agent tests for prompt, retry, validation, and history behavior.",
      "Check whether built-in skills or harness presets need matching wording.",
      "If the change affects tool choice, update tool descriptions or workspace recommended_next_steps.",
    ],
  },
  {
    id: "skills-instructions",
    title: "Skills or instruction files changed",
    patterns: [
      /^\.github\/skills\//,
      /^\.github\/instructions\//,
      /^\.github\/copilot-instructions\.md$/,
      /^\.agents\//,
      /^\.claude\//,
      /^lib\/skills\//,
    ],
    followUps: [
      "Validate skill frontmatter: name matches folder, description is specific, YAML is quoted when needed.",
      "Check workspace_init discovery if new instruction or skill layouts should be surfaced automatically.",
      "Run or update tests for list_skills/read_skill/write_skill when runtime skill behavior changes.",
    ],
  },
  {
    id: "persistence",
    title: "Persistence or schema changed",
    patterns: [
      /^lib\/db\//,
      /^lib\/stores\//,
    ],
    followUps: [
      "Add or update migration/store tests and verify idempotent re-runs.",
      "Open or update an ADR before changing persistence schema or directory layout.",
      "Check release notes for operator-visible migration or compatibility impact.",
    ],
  },
  {
    id: "api-contract",
    title: "API contract changed",
    patterns: [
      /^app\/api\//,
      /^api\//,
      /^lib\/api\//,
    ],
    followUps: [
      "Verify zod validation at the boundary and update shared api/types when payloads change.",
      "Run route/client tests for the touched endpoint.",
      "Check docs/api.md or README if the endpoint is documented.",
    ],
  },
  {
    id: "release-package",
    title: "Release or package metadata changed",
    patterns: [
      /^package\.json$/,
      /^package-lock\.json$/,
      /^CHANGELOG\.md$/,
      /^scripts\/(check-npm-package|rewrite-workspace-deps|release-docker)\.mjs$/,
      /^packages\/[^/]+\/package\.json$/,
      /^packages\/[^/]+\/CHANGELOG\.md$/,
    ],
    followUps: [
      "Confirm package.json and package-lock.json versions agree when releasing.",
      "Update CHANGELOG with user-facing changes and semver rationale.",
      "Run npm run build and package checks before tagging a release.",
    ],
  },
  {
    id: "repo-automation",
    title: "Repository automation changed",
    patterns: [
      /^scripts\/.+\.(mjs|js|ps1|sh|cmd)$/,
      /^\.github\/workflows\/.+\.ya?ml$/,
      /^eslint\.config\.mjs$/,
      /^vitest\.config\.ts$/,
      /^playwright\.config\.ts$/,
    ],
    followUps: [
      "Run the changed script directly with representative arguments before relying on it.",
      "Update package.json scripts or published files when the automation becomes a supported command.",
      "Check CI workflow wiring if the automation should run in pull requests or releases.",
    ],
  },
  {
    id: "security-sensitive",
    title: "Security-sensitive surface changed",
    patterns: [
      /^lib\/redaction\//,
      /^lib\/crypto\//,
      /^lib\/tools\/safety\.ts$/,
      /^scripts\/scan-(secrets|sensitive-terms)\.mjs$/,
      /^lib\/integrations\/.+oauth/i,
      /^lib\/stores\/credentials\./,
    ],
    followUps: [
      "Run security scanners for staged or full-tree changes.",
      "Check contributor-info-safety guidance before publishing logs, fixtures, or screenshots.",
      "Avoid exposing raw secrets in errors, logs, test names, snapshots, or PR text.",
    ],
  },
];

function usage() {
  return `Usage:
  node scripts/check-change-impact.mjs [--base <ref>] [--head <ref>] [--staged] [--json] [--fail-on-warnings]

Examples:
  node scripts/check-change-impact.mjs --base v1.29.4 --head origin/main
  node scripts/check-change-impact.mjs --base origin/main --head HEAD
  node scripts/check-change-impact.mjs --staged --fail-on-warnings
`;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

function defaultBaseRef() {
  const branch = tryGit(["branch", "--show-current"]);
  if (branch && branch !== "main" && branch !== "master") {
    const mergeBase = tryGit(["merge-base", "origin/main", "HEAD"]);
    if (mergeBase) return mergeBase;
  }
  const tag = tryGit(["describe", "--tags", "--abbrev=0"]);
  return tag || "origin/main";
}

function parseArgs(argv) {
  const out = { base: "", head: "HEAD", staged: false, json: false, failOnWarnings: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--staged") {
      out.staged = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--fail-on-warnings") {
      out.failOnWarnings = true;
    } else if (arg === "--base") {
      out.base = argv[++index] ?? "";
    } else if (arg === "--head") {
      out.head = argv[++index] ?? "";
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (out.staged && (out.base || out.head !== "HEAD")) {
    throw new Error("--staged cannot be combined with --base/--head");
  }
  if (!out.staged && !out.base) out.base = defaultBaseRef();
  return out;
}

function changedFiles(opts) {
  const args = opts.staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["diff", "--name-only", "--diff-filter=ACMR", `${opts.base}..${opts.head}`];
  const raw = git(args);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"));
}

function evaluate(files) {
  return RULES
    .map((rule) => {
      const matchedFiles = files.filter((file) => rule.patterns.some((pattern) => pattern.test(file)));
      return matchedFiles.length > 0
        ? { id: rule.id, title: rule.title, files: matchedFiles, follow_ups: rule.followUps }
        : null;
    })
    .filter(Boolean);
}

function printText(opts, files, findings) {
  const range = opts.staged ? "staged changes" : `${opts.base}..${opts.head}`;
  console.log(`[change-impact] range: ${range}`);
  console.log(`[change-impact] changed files: ${files.length}`);
  if (findings.length === 0) {
    console.log("[change-impact] PASS: no mapped ripple-impact surfaces detected.");
    return;
  }
  console.log(`[change-impact] ${findings.length} ripple-impact surface(s) detected:`);
  for (const finding of findings) {
    console.log(`\n- ${finding.title} (${finding.id})`);
    console.log("  Changed files:");
    for (const file of finding.files.slice(0, 12)) console.log(`    * ${file}`);
    if (finding.files.length > 12) console.log(`    * ... ${finding.files.length - 12} more`);
    console.log("  Follow-up checks:");
    for (const followUp of finding.follow_ups) console.log(`    * ${followUp}`);
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  if (!existsSync(".git")) {
    console.error("[change-impact] must run from the repository root");
    process.exit(2);
  }

  const files = changedFiles(opts);
  const findings = evaluate(files);
  if (opts.json) {
    console.log(JSON.stringify({ range: opts.staged ? "staged" : `${opts.base}..${opts.head}`, files, findings }, null, 2));
  } else {
    printText(opts, files, findings);
  }
  if (opts.failOnWarnings && findings.length > 0) process.exit(1);
}

main();
