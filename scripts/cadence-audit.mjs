#!/usr/bin/env node
// Clock-driven review for code that event-driven checks cannot see.
//
// CI, lint, and the pre-commit hook all run because something changed. A module
// nobody has committed to in months therefore has zero verification: its
// Agent.md may contradict the code, an ADR may point at a moved file, or a
// dependency may have acquired a high-severity advisory. This script audits
// those blind spots deterministically and prints a ranked decision list.
//
// Detection is local and code-only. The dependency audit is opt-in (`--audit`)
// because it queries the npm registry. There are no model calls.
//
// Usage:
//   node scripts/cadence-audit.mjs
//   node scripts/cadence-audit.mjs --format json
//   node scripts/cadence-audit.mjs --audit --report docs/CADENCE_REPORT.md
//   node scripts/cadence-audit.mjs --check
//
// Exit codes: 0 success (including advisory findings), 1 runtime failure or a
// P0 finding under --check, 2 usage or precondition failure.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import url from "node:url";
import { extractMarkdownLinks, GUIDES } from "./check-agent-docs.mjs";

const SELF_PATH = url.fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..");
const TAG = "[cadence]";
const DAY_MS = 86_400_000;

const CLASS_ORDER = ["dependency-staleness", "adr-rot", "doctrine-drift", "milestone-slippage"];
const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2 };
const CLASS_LABELS = {
  "dependency-staleness": "Dependency staleness",
  "adr-rot": "ADR rot",
  "doctrine-drift": "Doctrine drift on idle modules",
  "milestone-slippage": "Milestone slippage",
};

const ROOT_FILE = /^(?:AGENTS|CLAUDE|CHANGELOG|CONTRIBUTING|LICENSE|README)\.(?:md|txt)$|^(?:package|package-lock|tsconfig)\.json$|^(?:next\.config|proxy|instrumentation|instrumentation-node)\.ts$/;
const REPO_PATH_TOKEN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?$/;
const PATH_EXTENSION = /\.[A-Za-z0-9]+$/;
const GENERATED_PATH = /(?:^|\/)(?:node_modules|\.next|\.git|\.jarela-assets|coverage|dist|build)(?:\/|$)/;
const GENERATED_FILES = new Set(["docs/CHANGELOG.md", "docs/assets/project-history.html"]);

class UsageError extends Error {}

function write(stream, text) {
  stream.write(text);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ageInDays(now, date) {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
}

function isoDay(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function usage() {
  return `${TAG} deterministic cadence audit

Usage:
  node scripts/cadence-audit.mjs [options]

Options:
  --format <human|json>  Output format (default: human).
  --report <path>        Write the durable Markdown report, repository-relative.
                         The file is rewritten only when its content changes;
                         the Generated line records the last material change.
  --check                Exit 1 when any P0 finding exists, else 0.
  --audit                Run \`npm audit --omit=dev --audit-level=high\` and
                         include high/critical production advisories.
  --idle-days <n>        Doctrine-drift idle threshold in days (default: 90).
  --adr-age-days <n>     Age before an accepted ADR can be reported as
                         contradicted by a newer supersession (default: 30).
  --help, -h             Show this help.

Classes: dependency staleness, ADR rot, doctrine drift on idle modules,
milestone slippage. See docs/CADENCE.md for the escalation policy.
`;
}

export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const args = {
    format: "human",
    report: null,
    check: false,
    audit: false,
    idleDays: 90,
    adrAgeDays: 30,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--format") {
      const value = argv[index + 1];
      if (value !== "human" && value !== "json") {
        throw new UsageError("--format must be human or json");
      }
      args.format = value;
      index += 1;
    } else if (token === "--report") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new UsageError("--report needs a path");
      args.report = value;
      index += 1;
    } else if (token === "--check") {
      args.check = true;
    } else if (token === "--audit") {
      args.audit = true;
    } else if (token === "--idle-days" || token === "--adr-age-days") {
      const value = argv[index + 1];
      if (!/^\d+$/.test(value ?? "") || Number(value) < 1) {
        throw new UsageError(`${token} needs a positive integer`);
      }
      if (token === "--idle-days") args.idleDays = Number(value);
      else args.adrAgeDays = Number(value);
      index += 1;
    } else {
      throw new UsageError(`unknown argument: ${token}`);
    }
  }

  return args;
}

function resolveReportPath(repoRoot, input) {
  const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(repoRoot, input);
  const relative = path.relative(repoRoot, absolute);
  if (!relative || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UsageError("--report must name a file inside the repository");
  }
  return absolute;
}

export function gitLastCommit(repoRoot, scope) {
  const result = spawnSync(
    "git",
    ["-c", "log.showSignature=false", "log", "-1", "--format=%ct", "--", scope],
    { cwd: repoRoot, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) {
    return { ok: false, reason: (result.stderr || `git log exited ${result.status}`).trim() };
  }
  const raw = (result.stdout ?? "").trim();
  if (!raw) return { ok: true, epoch: null };
  const epoch = Number(raw);
  return Number.isFinite(epoch)
    ? { ok: true, epoch }
    : { ok: false, reason: `unexpected git log output: ${raw.slice(0, 80)}` };
}

function doctrineItem(scope, guide, ageDays, idleDays, lastCommitEpoch) {
  const severity = ageDays >= idleDays * 2 ? "P1" : "P2";
  // Keep the date, not a daily-changing age, so an unchanged report stays
  // byte-identical across ticks.
  return {
    id: `doctrine-drift:${scope}`,
    class: "doctrine-drift",
    severity,
    title: `Module ${scope} is idle beyond ${idleDays} days`,
    detail: `The last commit touching ${scope} was ${isoDay(lastCommitEpoch)}. Its guide is ${guide}.`,
    owner: `${scope} module owner`,
    action: "Review the guide against the code; update it or record why it still holds.",
    autoFixable: false,
  };
}

export function auditDoctrineDrift({ repoRoot, now, idleDays, lastCommit }) {
  const items = [];
  const skipped = [];
  const modules = GUIDES.filter((guide) => guide.format !== "instructions").sort((left, right) =>
    compareText(left.scope, right.scope));

  for (const { scope, guide } of modules) {
    if (!fs.existsSync(path.join(repoRoot, scope))) continue;
    const result = lastCommit(repoRoot, scope);
    if (!result?.ok) {
      skipped.push({
        id: "doctrine-drift",
        reason: `git history unavailable (${result?.reason ?? "unknown error"}); idle modules were not ranked`,
      });
      return { items, skipped };
    }
    if (result.epoch === null) {
      skipped.push({ id: `doctrine-drift:${scope}`, reason: `no commit touches ${scope}` });
      continue;
    }
    const ageDays = ageInDays(now, new Date(result.epoch * 1000));
    if (ageDays > idleDays) items.push(doctrineItem(scope, guide, ageDays, idleDays, result.epoch));
  }

  return { items, skipped };
}

function normalizeStatus(value) {
  return String(value ?? "")
    .replace(/^["']|["']$/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

export function classifyStatus(value) {
  const status = normalizeStatus(value).toLowerCase();
  if (!status) return "unknown";
  if (status.startsWith("superseded") || /\bsuperseded by\b/.test(status)) return "superseded";
  if (status.startsWith("accepted")) return "accepted";
  if (status.startsWith("proposed") || status.startsWith("implementation")) return "proposed";
  if (status.startsWith("deprecated")) return "deprecated";
  return "unknown";
}

function parseDate(value) {
  const text = normalizeStatus(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function supersederId(statusRaw) {
  return /superseded by\s+(?:\[)?ADR-(\d{4})/i.exec(normalizeStatus(statusRaw))?.[1] ?? null;
}

function supersedeClaims(fields, body) {
  const claims = new Set();
  for (const match of String(fields.supersedes ?? "").matchAll(/ADR-(\d{4})/g)) {
    claims.add(match[1]);
  }
  for (const line of body.split(/\r?\n/)) {
    const normalized = line
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*(?:[*+-]|\d+\.)\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
    const match = /^supersedes:?\s+ADR-(\d{4})\.?$/i.exec(normalized);
    if (match) claims.add(match[1]);
  }
  return [...claims].sort();
}

export function parseAdrSource(source, file) {
  const number = path.basename(file).slice(0, 4);
  const fields = {};
  let body = source;
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
      if (field) fields[field[1].toLowerCase()] = field[2].trim();
    }
    body = source.slice(frontmatter[0].length);
  }
  const rawStatus = fields.status ?? body.match(/^\s*Status:\s*(.+)$/im)?.[1] ?? "";
  const rawDate = fields.date ?? body.match(/^\s*Date:\s*(.+)$/im)?.[1] ?? "";
  return {
    file,
    number,
    status: classifyStatus(rawStatus),
    statusRaw: normalizeStatus(rawStatus),
    supersederId: supersederId(rawStatus),
    date: parseDate(rawDate),
    body,
    supersedeClaims: supersedeClaims(fields, body),
  };
}

export function isLikelyRepoPath(token) {
  if (!token || token.length > 160) return false;
  if (/\s/.test(token)) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(token)) return false;
  if (/^[/~.@]/.test(token)) return false;
  if (/[<>{}*?=|$!(),;[\]~`"']/.test(token)) return false;
  if (/X\.Y\.Z|(?:^|\/)(?:NNNN|XXXX)(?:[./]|$)/.test(token)) return false;
  if (GENERATED_FILES.has(token) || GENERATED_PATH.test(token)) return false;
  if (!token.includes("/")) return ROOT_FILE.test(token);
  if (!REPO_PATH_TOKEN.test(token)) return false;
  return PATH_EXTENSION.test(token) || token.endsWith("/");
}

export function extractAdrPathReferences(body) {
  const withoutFences = body.replace(/^```[\s\S]*?^```\s*$/gm, "");
  const references = new Set();
  for (const link of extractMarkdownLinks(withoutFences)) {
    const target = link.split("#")[0].replace(/\\/g, "/");
    if (isLikelyRepoPath(target)) references.add(target);
  }
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim();
    if (isLikelyRepoPath(token)) references.add(token);
  }
  return [...references].sort();
}

function referenceExists(repoRoot, adrDirectory, target) {
  const normalized = target.replace(/\\/g, "/");
  const rootPrefix = repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`;
  const candidates = path.isAbsolute(normalized)
    ? [path.resolve(normalized)]
    : [path.resolve(repoRoot, normalized), path.resolve(adrDirectory, normalized)];
  return candidates.some((candidate) => {
    if (candidate !== repoRoot && !candidate.startsWith(rootPrefix)) return false;
    return fs.existsSync(candidate);
  });
}

function adrPathItem(adr, missing) {
  const shown = missing.slice(0, 6).map((target) => `\`${target}\``).join(", ");
  const suffix = missing.length > 6 ? ` and ${missing.length - 6} more` : "";
  return {
    id: `adr-rot:${adr.number}`,
    class: "adr-rot",
    severity: "P1",
    title: `ADR-${adr.number} references ${missing.length} missing path(s)`,
    detail: `docs/adr/${adr.file} (status: ${adr.status}) references ${shown}${suffix}, which do not exist in the repository.`,
    owner: "docs/adr maintainer",
    action: "Update the reference or record that the path was intentionally removed; do not rewrite the decision.",
    autoFixable: false,
  };
}

function adrContradictionItem(adr, newerNumber) {
  return {
    id: `adr-rot:${adr.number}:status`,
    class: "adr-rot",
    severity: "P1",
    title: `ADR-${adr.number} still says accepted; ADR-${newerNumber} supersedes it`,
    detail: `ADR-${adr.number} (dated ${adr.date.toISOString().slice(0, 10)}) still records status "accepted"; ADR-${newerNumber} claims to supersede it.`,
    owner: "docs/adr maintainer",
    action: `Record the supersession in ADR-${adr.number}; this audit reports and never rewrites.`,
    autoFixable: false,
  };
}

function adrMissingSupersederItem(adr) {
  return {
    id: `adr-rot:${adr.number}:superseder`,
    class: "adr-rot",
    severity: "P1",
    title: `ADR-${adr.number} claims supersession by ADR-${adr.supersederId}, which is missing`,
    detail: `docs/adr/${adr.file} records status "${adr.statusRaw}", but docs/adr/${adr.supersederId}-*.md does not exist.`,
    owner: "docs/adr maintainer",
    action: "Correct the supersession pointer or restore the missing record.",
    autoFixable: false,
  };
}

export function auditAdrRot({ repoRoot, now, adrAgeDays }) {
  const items = [];
  const skipped = [];
  const directory = path.join(repoRoot, "docs", "adr");
  const directoryInfo = fs.existsSync(directory) ? fs.statSync(directory) : null;
  if (!directoryInfo?.isDirectory()) {
    skipped.push({ id: "adr-rot", reason: "docs/adr is missing; ADR rot was not ranked" });
    return { items, skipped };
  }

  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}-.*\.md$/.test(entry.name) && !entry.name.startsWith("0000-"))
    .map((entry) => entry.name)
    .sort();
  const adrs = files.map((file) => {
    const source = fs.readFileSync(path.join(directory, file), "utf8");
    return parseAdrSource(source, file);
  });
  const byNumber = new Map(adrs.map((adr) => [adr.number, adr]));

  for (const adr of adrs) {
    if (adr.status !== "accepted" && adr.status !== "superseded") continue;
    const missing = extractAdrPathReferences(adr.body)
      .filter((target) => !referenceExists(repoRoot, directory, target));
    if (missing.length > 0) items.push(adrPathItem(adr, missing));
    if (adr.supersederId && !byNumber.has(adr.supersederId)) {
      items.push(adrMissingSupersederItem(adr));
    }
  }

  const claims = new Map();
  for (const adr of adrs) {
    // A proposed ADR does not supersede anything yet. Only an accepted record
    // can contradict another accepted record.
    if (adr.status !== "accepted") continue;
    for (const target of adr.supersedeClaims) {
      const claimants = claims.get(target) ?? [];
      claimants.push(adr.number);
      claims.set(target, claimants);
    }
  }
  for (const [targetId, newerIds] of claims) {
    const target = byNumber.get(targetId);
    if (!target || target.status !== "accepted" || !target.date) continue;
    const newerNumber = [...newerIds].sort().at(-1);
    if (Number(newerNumber) <= Number(targetId)) continue;
    const ageDays = ageInDays(now, target.date);
    if (ageDays <= adrAgeDays) continue;
    items.push(adrContradictionItem(target, newerNumber));
  }

  return { items, skipped };
}

export function defaultRunAudit(repoRoot) {
  const useCmd = process.platform === "win32";
  const executable = useCmd ? (process.env.ComSpec || "cmd.exe") : "npm";
  const commandArgs = ["audit", "--omit=dev", "--audit-level=high", "--json"];
  const result = spawnSync(
    executable,
    useCmd ? ["/d", "/s", "/c", "npm", ...commandArgs] : commandArgs,
    { cwd: repoRoot, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function parseAuditJson(output) {
  const text = String(output.stdout ?? "").trim();
  const start = text.indexOf("{");
  if (start < 0) throw new Error("npm audit produced no JSON");
  return JSON.parse(text.slice(start));
}

function dependencyItem(entry) {
  const advisories = (entry.via ?? []).filter((via) => typeof via === "object");
  const titles = advisories.map((via) => via.title).filter(Boolean);
  const fixAvailable = entry.fixAvailable === true;
  const fixText = fixAvailable
    ? "An in-range fix is available."
    : entry.fixAvailable
      ? "Only a semver-major upgrade fixes it."
      : "No fix is currently available.";
  return {
    id: `dependency-staleness:${entry.name}`,
    class: "dependency-staleness",
    severity: entry.severity === "critical" ? "P0" : "P1",
    title: `${entry.severity === "critical" ? "Critical" : "High"} vulnerability in ${entry.name}`,
    detail: [
      titles.length > 0 ? `Advisory: ${titles.join("; ")}.` : null,
      entry.range ? `Vulnerable range: ${entry.range}.` : null,
      fixText,
    ].filter(Boolean).join(" "),
    owner: "dependency maintainer",
    action: "Upgrade the dependency or record a reviewed exception.",
    autoFixable: fixAvailable,
  };
}

export function auditDependencies({ repoRoot, audit, runAudit }) {
  if (!audit) {
    return {
      items: [],
      skipped: [{ id: "dependency-staleness", reason: "not requested; pass --audit to query the npm registry" }],
    };
  }
  let output = null;
  try {
    output = runAudit(repoRoot);
  } catch (error) {
    return {
      items: [],
      skipped: [{ id: "dependency-staleness", reason: `npm audit failed: ${error.message}` }],
    };
  }
  if (output.error || (output.status !== 0 && output.status !== 1)) {
    const reason = output.error?.message ?? `npm audit exited ${output.status}: ${(output.stderr ?? "").trim()}`;
    return { items: [], skipped: [{ id: "dependency-staleness", reason }] };
  }
  let report = null;
  try {
    report = parseAuditJson(output);
  } catch (error) {
    return {
      items: [],
      skipped: [{ id: "dependency-staleness", reason: `could not parse npm audit output: ${error.message}` }],
    };
  }
  if (report.error) {
    return {
      items: [],
      skipped: [{ id: "dependency-staleness", reason: `npm audit error: ${report.error.summary ?? report.error.code ?? "unknown"}` }],
    };
  }
  const items = Object.values(report.vulnerabilities ?? {})
    .filter((entry) => entry.severity === "high" || entry.severity === "critical")
    .map(dependencyItem);
  return { items, skipped: [] };
}

export function auditMilestones({ repoRoot }) {
  const docs = path.join(repoRoot, "docs");
  const docsInfo = fs.existsSync(docs) ? fs.statSync(docs) : null;
  let candidates = [];
  if (docsInfo?.isDirectory()) {
    candidates = fs
      .readdirSync(docs, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.json$/i.test(entry.name) && /(milestone|roadmap|phase)/i.test(entry.name))
      .map((entry) => `docs/${entry.name}`)
      .sort();
  }
  const post3 = path.join(docs, "POST_3_DIRECTION.md");
  const naming = candidates.length > 0
    ? `${candidates.join(", ")} exists, but this audit has no schema contract for it`
    : fs.existsSync(post3)
      ? "docs/POST_3_DIRECTION.md tracks planned minor upgrades as prose and tables"
      : "no milestone or phase file was found under docs/";
  return {
    items: [{
      id: "milestone-slippage:needs_manual_review",
      class: "milestone-slippage",
      severity: "P2",
      title: "Milestone slippage needs manual review",
      detail: `${naming}; it does not parse prose or invent a milestone schema.`,
      owner: "product maintainer",
      action: "Review planned minor upgrades and record whether any target slipped.",
      autoFixable: false,
    }],
    skipped: [],
  };
}

export function rankItems(items) {
  return [...items].sort((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || CLASS_ORDER.indexOf(left.class) - CLASS_ORDER.indexOf(right.class)
    || compareText(left.id, right.id));
}

export function exitCodeFor(result) {
  return result.items.some((item) => item.severity === "P0") ? 1 : 0;
}

export function buildResult({ repoRoot, now, idleDays, adrAgeDays, audit, deps = {} }) {
  const lastCommit = deps.lastCommit ?? gitLastCommit;
  const runAudit = deps.runAudit ?? defaultRunAudit;
  const parts = [
    auditDependencies({ repoRoot, audit, runAudit }),
    auditAdrRot({ repoRoot, now, adrAgeDays }),
    auditDoctrineDrift({ repoRoot, now, idleDays, lastCommit }),
    auditMilestones({ repoRoot }),
  ];
  const items = rankItems(parts.flatMap((part) => part.items));
  const skipped = [...parts.flatMap((part) => part.skipped)]
    .sort((left, right) => compareText(left.id, right.id));
  return { generatedAt: now.toISOString(), items, skipped };
}

function formatItem(item) {
  return [
    `- **${item.severity} · ${item.class}** — ${item.title}`,
    `  - Detail: ${item.detail}`,
    `  - Owner: ${item.owner}`,
    `  - Action: ${item.action}`,
    `  - Auto-fixable: ${item.autoFixable ? "yes" : "no"}`,
  ].join("\n");
}

function cleanReason(classId, options) {
  if (classId === "doctrine-drift") {
    return `no module has exceeded the ${options.idleDays}-day idle threshold`;
  }
  if (classId === "adr-rot") {
    return "no accepted or superseded ADR references a missing in-repo path, and no newer ADR contradicts an accepted status";
  }
  if (classId === "dependency-staleness") {
    return "npm audit reported no high or critical production vulnerabilities";
  }
  return "no open milestone decision";
}

export function renderMarkdown(result, options) {
  const lines = [
    "# Cadence review report",
    "",
    `Generated: ${result.generatedAt}`,
    "",
    "> Generated by `node scripts/cadence-audit.mjs`. This file is the durable",
    "> artifact of the weekly cadence review. A tick that finds nothing records",
    "> \"No change recorded\" below instead of reporting green into a void.",
    "",
    `Configuration: idle threshold ${options.idleDays} days; ADR age threshold ${options.adrAgeDays} days; dependency audit ${options.audit ? "requested" : "not requested"}.`,
    "",
    "## Ranked decisions",
    "",
  ];
  lines.push(result.items.length > 0
    ? result.items.map(formatItem).join("\n")
    : "No open decisions in this run.");
  lines.push("", "## No change recorded", "");

  const openClasses = new Set(result.items.map((item) => item.class));
  const skippedClasses = new Set(result.skipped.map((entry) => entry.id.split(":")[0]));
  const clean = CLASS_ORDER.filter((classId) =>
    !openClasses.has(classId) && !skippedClasses.has(classId));
  if (clean.length === 0) {
    lines.push("None; every checked class produced a decision or was skipped.");
  } else {
    for (const classId of clean) {
      lines.push(`- ${CLASS_LABELS[classId]}: ${cleanReason(classId, options)}.`);
    }
  }

  lines.push("", "## Skipped", "");
  lines.push(result.skipped.length > 0
    ? result.skipped.map((entry) => `- ${entry.id}: ${entry.reason}.`).join("\n")
    : "None.");
  lines.push("");
  return lines.join("\n");
}

function normalizeReport(text) {
  return text.replace(/\r\n/g, "\n").replace(/^Generated: .*$/m, "Generated: <timestamp>");
}

export function writeReport(reportPath, markdown) {
  let existing = null;
  try {
    existing = fs.readFileSync(reportPath, "utf8");
  } catch {
    existing = null;
  }
  if (existing !== null && normalizeReport(existing) === normalizeReport(markdown)) {
    return { changed: false };
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, markdown, "utf8");
  return { changed: true };
}

function humanOutput(result) {
  const lines = [`${TAG} ${result.items.length} decision(s), ${result.skipped.length} skipped`];
  for (const item of result.items) {
    lines.push(`${TAG} ${item.severity} ${item.class} ${item.id}`);
    lines.push(`${TAG}   ${item.title}`);
    lines.push(`${TAG}   action: ${item.action}`);
  }
  for (const entry of result.skipped) {
    lines.push(`${TAG} SKIP ${entry.id}: ${entry.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2), options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const now = options.now ?? new Date();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const args = parseArgs(argv);
    if (args.help) {
      write(stdout, usage());
      return 0;
    }
    const reportPath = args.report ? resolveReportPath(repoRoot, args.report) : null;
    const result = buildResult({
      repoRoot,
      now,
      idleDays: args.idleDays,
      adrAgeDays: args.adrAgeDays,
      audit: args.audit,
      deps: options.deps,
    });

    if (reportPath) {
      const report = writeReport(reportPath, renderMarkdown(result, args));
      const relative = path.relative(repoRoot, reportPath).replace(/\\/g, "/");
      write(stderr, `${TAG} report ${report.changed ? "written" : "unchanged"}: ${relative}\n`);
    }

    if (args.format === "json") {
      write(stdout, `${JSON.stringify(result, null, 2)}\n`);
    } else {
      write(stdout, humanOutput(result));
    }

    if (args.check) {
      const code = exitCodeFor(result);
      if (code !== 0) {
        write(stderr, `${TAG} check failed: ${result.items.filter((item) => item.severity === "P0").length} P0 finding(s)\n`);
      } else {
        write(stderr, `${TAG} check passed: no P0 findings\n`);
      }
      return code;
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      write(stderr, `${TAG} usage: ${error.message}\n${usage()}`);
      return 2;
    }
    write(stderr, `${TAG} error: ${error?.stack ?? error}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`${TAG} fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}
