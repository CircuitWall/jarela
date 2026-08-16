#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "build", "ci", "chore"];
const IMPERATIVE_VERBS = new Set([
  "add",
  "align",
  "allow",
  "avoid",
  "backfill",
  "block",
  "bump",
  "check",
  "clean",
  "codify",
  "configure",
  "detect",
  "document",
  "drop",
  "enable",
  "enforce",
  "expose",
  "fix",
  "gate",
  "generate",
  "group",
  "hide",
  "ignore",
  "keep",
  "merge",
  "move",
  "normalize",
  "pin",
  "prevent",
  "publish",
  "refresh",
  "register",
  "remove",
  "render",
  "require",
  "reset",
  "restore",
  "reuse",
  "route",
  "run",
  "skip",
  "split",
  "stream",
  "tolerate",
  "update",
  "use",
  "validate",
  "verify",
  "wire",
]);
const TYPE_PATTERN = TYPES.join("|");
const SUBJECT_RE = new RegExp(`^(${TYPE_PATTERN})(\\([a-z0-9_/-]+\\))(!)?: ([a-z][a-z0-9 .,/':+-]*)$`);

function usage() {
  return `Usage:
  node scripts/check-git-conventions.mjs --branch
  node scripts/check-git-conventions.mjs --message-file <path>
  node scripts/check-git-conventions.mjs --subject <subject> [--label <label>]
  node scripts/check-git-conventions.mjs --subject-env <env-name> [--label <label>]
  node scripts/check-git-conventions.mjs --range <git-range> [--label <label>]
`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function git(args) {
  return execFileSync("git", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function firstCommitLine(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#")) ?? "";
}

function validateSubject(subject, label = "subject") {
  const errors = [];
  if (subject.length > 72) {
    errors.push(`must be 72 characters or less (got ${subject.length})`);
  }
  if (!SUBJECT_RE.test(subject)) {
    errors.push(`must match: type(scope)[!]: lowercase imperative description`);
  }

  const description = subject.includes(": ") ? subject.slice(subject.indexOf(": ") + 2) : "";
  const firstWord = description.split(/\s+/, 1)[0] ?? "";
  if (firstWord && !IMPERATIVE_VERBS.has(firstWord)) {
    errors.push(`description must start with a recognized imperative verb (got "${firstWord}")`);
  }
  if (/[A-Z]/.test(description)) {
    errors.push("description must be lowercase; avoid uppercase abbreviations like PR/API/CI");
  }
  if (description.endsWith(".")) {
    errors.push("description must not end with a period");
  }
  if (/[()]/.test(description)) {
    errors.push("description must not contain parenthesized asides; use scope instead");
  }

  if (errors.length > 0) {
    fail(`[git-conventions] invalid ${label}: ${subject}\n- ${errors.join("\n- ")}`);
    return false;
  }
  return true;
}

function validateCommitMessage(path) {
  const raw = readFileSync(path, "utf8");
  const subject = firstCommitLine(raw);
  let ok = validateSubject(subject, "commit subject");
  const hasBang = /^(feat|fix|docs|refactor|perf|test|build|ci|chore)(\([a-z0-9_/-]+\))!: /.test(subject);
  const hasBreakingFooter = /^BREAKING CHANGE: .+/m.test(raw);
  if (hasBang && !hasBreakingFooter) {
    fail("[git-conventions] breaking commits must include a BREAKING CHANGE: footer");
    ok = false;
  }
  if (!hasBang && hasBreakingFooter) {
    fail("[git-conventions] BREAKING CHANGE footer requires ! before the subject colon");
    ok = false;
  }
  return ok;
}

function validateBranch() {
  let branch = "";
  try {
    branch = git(["branch", "--show-current"]);
  } catch {
    return true;
  }
  if (!branch) return true;
  if (branch === "main" || branch === "master") {
    fail(`[git-conventions] commits must be made on a topic branch, not ${branch}`);
    return false;
  }
  if (!/^(feat|fix|docs|refactor|perf|test|build|ci|chore)\/[a-z0-9._/-]+$/.test(branch)) {
    fail(`[git-conventions] branch must be topic-typed, e.g. fix/thing or docs/thing (got ${branch})`);
    return false;
  }
  return true;
}

function validateRange(range, label = "commit subject") {
  let rows = "";
  try {
    rows = git(["log", "--format=%H%x09%s", range]);
  } catch (err) {
    fail(`[git-conventions] failed to read git range ${range}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!rows) return true;
  let ok = true;
  for (const row of rows.split(/\r?\n/)) {
    const [hash, subject] = row.split("\t", 2);
    if (!validateSubject(subject, `${label} ${hash.slice(0, 12)}`)) ok = false;
  }
  return ok;
}

const args = process.argv.slice(2);
let ok = true;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--branch") {
    ok = validateBranch() && ok;
  } else if (arg === "--message-file") {
    const path = args[++i];
    if (!path) {
      fail("[git-conventions] --message-file requires a path");
      ok = false;
    } else {
      ok = validateCommitMessage(path) && ok;
    }
  } else if (arg === "--subject") {
    const subject = args[++i];
    if (!subject) {
      fail("[git-conventions] --subject requires a value");
      ok = false;
    } else {
      const labelIndex = args.indexOf("--label");
      const label = labelIndex >= 0 ? args[labelIndex + 1] : "subject";
      ok = validateSubject(subject, label) && ok;
    }
  } else if (arg === "--subject-env") {
    const envName = args[++i];
    const subject = envName ? process.env[envName] : "";
    if (!envName || !subject) {
      fail("[git-conventions] --subject-env requires a populated environment variable name");
      ok = false;
    } else {
      const labelIndex = args.indexOf("--label");
      const label = labelIndex >= 0 ? args[labelIndex + 1] : "subject";
      ok = validateSubject(subject, label) && ok;
    }
  } else if (arg === "--range") {
    const range = args[++i];
    if (!range) {
      fail("[git-conventions] --range requires a git revision range");
      ok = false;
    } else {
      const labelIndex = args.indexOf("--label");
      const label = labelIndex >= 0 ? args[labelIndex + 1] : "commit subject";
      ok = validateRange(range, label) && ok;
    }
  } else if (arg === "--label") {
    i += 1;
  } else if (arg === "--help" || arg === "-h") {
    process.stdout.write(usage());
    process.exit(0);
  } else {
    fail(`[git-conventions] unknown argument: ${arg}\n${usage()}`);
    ok = false;
  }
}

if (args.length === 0) {
  fail(`[git-conventions] no check requested\n${usage()}`);
  ok = false;
}

process.exit(ok ? 0 : 1);
