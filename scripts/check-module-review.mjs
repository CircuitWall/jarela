#!/usr/bin/env node
// Change-scoped module review.
//
// Maps changed files to the owning Agent.md, prints that guide's Review checks,
// and runs mechanical structure checks that are cheap enough for a pre-commit
// hook. Manual checklist items remain review obligations; this script does not
// pretend to verify judgment calls.
//
// Usage:
//   node scripts/check-module-review.mjs --staged
//   node scripts/check-module-review.mjs --base origin/main --head HEAD
//   node scripts/check-module-review.mjs --name-status-file <file>
//   node scripts/check-module-review.mjs --json
//   node scripts/check-module-review.mjs --fail-on-warnings
//
// Exit codes: 0 clean or warnings only, 1 failed checks, 2 usage error.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { GUIDES } from "./check-agent-docs.mjs";

const SELF_PATH = url.fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..");

export const MODULE_GUIDES = GUIDES
  .filter((entry) => entry.guide !== "AGENTS.md")
  .map((entry) => ({ guide: entry.guide, scope: entry.scope.replace(/\/+$/, "") }))
  .sort((a, b) => b.scope.length - a.scope.length);

const GUIDE_ALIASES = [
  { prefix: "contexts/", guide: "components/Agent.md" },
  { prefix: "lib/ui/", guide: "components/Agent.md" },
];

const UI_PREFIXES = ["components/", "hooks/", "contexts/", "lib/ui/"];
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;
const TEST = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

const RULES = {
  uiServerImport:
    /from\s+["'](?:@\/lib\/(?:db|stores|crypto|scheduler|notifications)(?:\/[^"']*)?|@\/app\/[^"']*|server-only)["']/,
  sqlPrepare: /\.prepare\s*\(/,
  apiUiImport: /from\s+["']@\/(?:components|hooks)\//,
  getDb: /\bgetDb\s*\(/,
  shellTrue: /\bshell\s*:\s*true\b/,
  processExit: /\bprocess\.exit\s*\(/,
  processCwd: /\bprocess\.cwd\s*\(/,
  manualTx: /\.exec\s*\(\s*[`"']\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i,
  pragma: /\bPRAGMA\s+(?:journal_mode|synchronous|busy_timeout|foreign_keys)\b/i,
  consoleLog: /\bconsole\.log\s*\(/,
  promptConst: /export\s+const\s+[A-Z0-9_]*PROMPT[A-Z0-9_]*\s*=/,
  waitForTimeout: /\bwaitForTimeout\s*\(/,
  directPlaywright:
    /import\s*\{[^}]*\b(?:test|expect)\b[^}]*\}\s*from\s*["']@playwright\/test["']/,
  directFetch: /\bfetch\s*\(/,
  directStorage: /\b(?:localStorage|sessionStorage|indexedDB)\b/,
};

const PROVIDER_INFRA = new Set([
  "builtins",
  "index",
  "registry",
  "types",
  "errors",
  "credentials",
  "rate-limit",
  "capabilities",
  "known-context-windows",
  "streaming",
  "tool-arguments",
  "tool-limit",
  "provider-integrations",
  "provider-integration-map",
  "external",
  "jarela-chat-model",
]);

const normalize = (file) => file.replace(/\\/g, "/");
const isSource = (file) => SOURCE.test(file) && !TEST.test(file);
const isReviewable = (file) => isSource(file) || TEST.test(file);

export function moduleForPath(file, guides = MODULE_GUIDES) {
  const normalized = normalize(file);
  const direct = guides.find(
    ({ scope }) => normalized === scope || normalized.startsWith(`${scope}/`),
  );
  if (direct) return direct;
  const alias = GUIDE_ALIASES.find(({ prefix }) => normalized.startsWith(prefix));
  if (!alias) return null;
  return guides.find(({ guide }) => guide === alias.guide) ?? { guide: alias.guide, scope: "" };
}

export function parseNameStatus(raw) {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  const changes = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const from = tokens[index++];
      const to = tokens[index++];
      if (from === undefined || to === undefined) break;
      changes.push({ status: "D", path: from }, { status: "A", path: to });
    } else {
      const file = tokens[index++];
      if (file === undefined) break;
      changes.push({ status: kind, path: file });
    }
  }
  return changes;
}

export function extractReviewChecks(markdown) {
  const checks = [];
  let inSection = false;
  let current = null;
  const flush = () => {
    if (current) checks.push(current);
    current = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      if (inSection) break;
      inSection = /^##\s+Review checks\s*$/i.test(line);
      continue;
    }
    if (!inSection) continue;

    const item = line.match(/^(\s*)- \[[ xX]\]\s+(.*)$/);
    if (item) {
      flush();
      current = { indent: item[1].length, text: item[2].trim() };
      continue;
    }
    if (!current) continue;
    const continuation = line.trim();
    if (!continuation) flush();
    else if (!/^[-*]\s|^\d+\.\s/.test(continuation)) current.text += ` ${continuation}`;
    else flush();
  }
  flush();
  return checks;
}

function findLine(content, regex) {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    // Comments frequently contain examples of the pattern being banned.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    if (regex.test(lines[index])) return { line: index + 1, text: lines[index].trim() };
  }
  return null;
}

function readRepoFile(repoRoot, file) {
  const absolute = path.join(repoRoot, file);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

export function runRepoCheck(repoRoot, script) {
  try {
    execFileSync(process.execPath, [script], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: "" };
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    return { ok: false, output: output.split(/\r?\n/).slice(-6).join("\n") };
  }
}

function checkUiGroup(contents, changedFiles, add, check) {
  for (const [file, content] of contents) {
    if (!UI_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    const server = findLine(content, RULES.uiServerImport);
    if (server) {
      add(
        "error",
        "ui-boundary",
        `${file}:${server.line} imports server-only or app code`,
        "Move persistence behind api/client.ts or a hook.",
      );
    }
    const sql = findLine(content, RULES.sqlPrepare);
    if (sql) {
      add("error", "ui-sql", `${file}:${sql.line} calls .prepare()`, "Move SQL into a store.");
    }
  }
  if (!changedFiles.some((file) => UI_PREFIXES.some((prefix) => file.startsWith(prefix)))) return;
  const result = check("scripts/check-ui-data-access.mjs");
  if (!result.ok) {
    add(
      "error",
      "ui-data-access",
      "Direct fetch/localStorage ratchet failed",
      result.output,
    );
  }
}

function checkApiGroup(contents, changedFiles, add, check) {
  for (const [file, content] of contents) {
    if (!file.startsWith("app/api/")) continue;
    const sql = findLine(content, RULES.sqlPrepare);
    if (sql) {
      add("error", "api-sql", `${file}:${sql.line} calls .prepare()`, "Call a typed store instead.");
    }
    const ui = findLine(content, RULES.apiUiImport);
    if (ui) {
      add("error", "api-ui-import", `${file}:${ui.line} imports UI code`, "Move shared logic to api/ or lib/.");
    }
    const db = findLine(content, RULES.getDb);
    if (db) {
      add(
        "warn",
        "api-getdb",
        `${file}:${db.line} calls getDb(); only bootstrap helpers may.`,
        "Use a store or runtime function.",
      );
    }
  }
  if (!changedFiles.some((file) => file.startsWith("app/api/"))) return;
  const result = check("scripts/check-api-docs.mjs");
  if (!result.ok) {
    add("error", "api-docs", "Public route markers and docs/api.md disagree", result.output);
  }
}

function checkToolsGroup(repoRoot, sourceChanges, contents, add) {
  const builtins = readRepoFile(repoRoot, "lib/tools/runtime/builtins.ts") ?? "";
  for (const change of sourceChanges) {
    const file = change.path;
    if (!file.startsWith("lib/tools/")) continue;
    const relative = normalize(path.relative(path.join(repoRoot, "lib/tools"), path.join(repoRoot, file)));
    if (
      relative.startsWith("runtime/") ||
      relative.startsWith("packages/") ||
      relative.startsWith("support/") ||
      relative.startsWith("core/") ||
      !relative.endsWith(".ts")
    ) {
      continue;
    }
    const content = contents.get(file) ?? "";
    if (!/register(?:LangChainPackage|Tools)\s*\(/.test(content)) continue;
    const specifier = `../${relative.replace(/\.ts$/, "")}`;
    if (!builtins.includes(`"${specifier}"`) && !builtins.includes(`'${specifier}'`)) {
      add(
        "error",
        "tool-unregistered",
        `${file} registers tools but lib/tools/runtime/builtins.ts does not import ${specifier}`,
        "Add the side-effect import.",
      );
    }
    if (change.status === "A" && !existsSync(path.join(repoRoot, file.replace(/\.ts$/, ".test.ts")))) {
      add(
        "warn",
        "tool-test",
        `${file} is new and has no sibling .test.ts`,
        "Add registration, schema, and behavior tests.",
      );
    }
  }
}

function checkProvidersGroup(repoRoot, sourceChanges, contents, add) {
  const builtins = readRepoFile(repoRoot, "lib/providers/builtins.ts") ?? "";
  const docs = readRepoFile(repoRoot, "docs/index.md") ?? "";
  for (const change of sourceChanges) {
    const file = change.path;
    if (!file.startsWith("lib/providers/") || !file.endsWith(".ts")) continue;
    const base = path.basename(file, ".ts");
    if (PROVIDER_INFRA.has(base)) continue;
    const content = contents.get(file) ?? "";
    if (!/ModelProvider|makeOpenAICompatProvider/.test(content)) continue;
    if (change.status === "A") {
      if (!builtins.includes(`"./${base}"`) && !builtins.includes(`'./${base}'`)) {
        add(
          "error",
          "provider-unregistered",
          `${file} is not imported by lib/providers/builtins.ts`,
          "Add the static import and registration.",
        );
      }
      if (!existsSync(path.join(repoRoot, file.replace(/\.ts$/, ".test.ts")))) {
        add("warn", "provider-test", `${file} is new and has no sibling .test.ts`, "Add adapter tests.");
      }
      const name =
        content.match(/makeOpenAICompatProvider\(\s*["']([^"']+)["']/)?.[1] ??
        content.match(/name:\s*["']([^"']+)["']/)?.[1];
      if (name && !docs.includes(name)) {
        add(
          "warn",
          "provider-docs",
          `${file} adds provider "${name}" but docs/index.md does not mention it`,
          "Update the provider list.",
        );
      }
    }
  }
}

function checkDbGroup(repoRoot, sourceChanges, contents, changedSet, add) {
  for (const change of sourceChanges) {
    const file = change.path;
    if (!file.startsWith("lib/db/") || path.basename(file) === "pragmas.ts") continue;
    const pragma = findLine(contents.get(file) ?? "", RULES.pragma);
    if (pragma) {
      add(
        "error",
        "db-pragma",
        `${file}:${pragma.line} sets a connection pragma outside pragmas.ts`,
        "Use applyConnectionPragmas().",
      );
    }
  }
  if (changedSet.has("lib/db/pragmas.ts") && !changedSet.has("lib/db/pragmas.test.ts")) {
    add("warn", "db-pragma-test", "pragmas.ts changed without pragmas.test.ts", "Update the pragma profile test.");
  }
  if (
    changedSet.has("lib/db/migrations.ts") &&
    !changedSet.has("lib/db/migrations.test.ts") &&
    !changedSet.has("lib/db/versioned-migrations.test.ts")
  ) {
    add(
      "warn",
      "db-migration-test",
      "migrations.ts changed without a migration test",
      "Cover fresh install, upgrade, and idempotent re-run.",
    );
  }
}

function checkStoresGroup(repoRoot, sourceChanges, contents, add) {
  for (const change of sourceChanges) {
    const file = change.path;
    if (!file.startsWith("lib/stores/")) continue;
    const content = contents.get(file) ?? "";
    const manual = findLine(content, RULES.manualTx);
    if (manual) {
      add(
        "error",
        "store-manual-tx",
        `${file}:${manual.line} issues BEGIN/COMMIT/ROLLBACK`,
        "Use withDbTransaction().",
      );
    }
    if (findLine(content, RULES.directFetch) || findLine(content, RULES.directStorage)) {
      add(
        "warn",
        "store-io",
        `${file} performs network or browser storage IO`,
        "Stores own SQL; callers own transport.",
      );
    }
    if (
      change.status === "A" &&
      !existsSync(path.join(repoRoot, file.replace(/\.ts$/, ".test.ts")))
    ) {
      add("warn", "store-test", `${file} is new and has no sibling .test.ts`, "Add store tests.");
    }
  }
}

function checkScriptsGroup(sourceChanges, contents, add) {
  for (const change of sourceChanges) {
    const file = change.path;
    if (!file.startsWith("scripts/") || !file.endsWith(".mjs")) continue;
    // This gate's own diagnostics mention the banned patterns in template
    // literals; its behavior is covered by check-module-review.test.mjs.
    if (file === "scripts/check-module-review.mjs") continue;
    const content = contents.get(file) ?? "";
    const shell = findLine(content, RULES.shellTrue);
    if (shell) {
      add(
        "error",
        "script-shell",
        `${file}:${shell.line} enables shell: true`,
        "Use execFileSync with an argument array.",
      );
    }
    const exit = findLine(content, RULES.processExit);
    if (exit) {
      add(
        "warn",
        "script-exit",
        `${file}:${exit.line} calls process.exit()`,
        "Accumulate diagnostics, set process.exitCode, and exit once in main().",
      );
    }
    const cwd = findLine(content, RULES.processCwd);
    if (cwd) {
      add(
        "warn",
        "script-cwd",
        `${file}:${cwd.line} reads process.cwd()`,
        "Resolve the repository root from the module URL.",
      );
    }
  }
}

function checkAgentsGroup(sourceChanges, contents, changedSet, add) {
  for (const change of sourceChanges) {
    const file = change.path;
    if (!file.startsWith("lib/agents/")) continue;
    const content = contents.get(file) ?? "";
    const log = findLine(content, RULES.consoleLog);
    if (log) {
      add("warn", "agent-console", `${file}:${log.line} calls console.log()`, "Use structured logging.");
    }
    if (
      findLine(content, RULES.promptConst) &&
      !changedSet.has("lib/agents/prompt-registry.ts")
    ) {
      add(
        "warn",
        "agent-prompt-registry",
        `${file} defines prompt text; prompt-registry.ts did not change`,
        "Register the prompt and update its eval/dump coverage.",
      );
    }
  }
}

function checkTestsGroup(changes, contents, add) {
  for (const change of changes) {
    const file = change.path;
    if (!file.startsWith("tests/e2e/") || !file.endsWith(".spec.ts")) continue;
    const content = contents.get(file) ?? "";
    const sleep = findLine(content, RULES.waitForTimeout);
    if (sleep) {
      add(
        "warn",
        "e2e-sleep",
        `${file}:${sleep.line} calls waitForTimeout()`,
        "Wait on state with expect.poll or a web-first assertion.",
      );
    }
    const direct = findLine(content, RULES.directPlaywright);
    if (direct) {
      add(
        "warn",
        "e2e-fixtures",
        `${file}:${direct.line} imports test/expect from @playwright/test`,
        "Import from tests/e2e/fixtures.ts.",
      );
    }
  }
}

function checkNaming(changes, add) {
  for (const change of changes) {
    if (change.status !== "A" || !isSource(change.path)) continue;
    const file = change.path;
    const base = path.basename(file);
    if (file.startsWith("components/") && file.endsWith(".tsx") && !/^[A-Z]/.test(base)) {
      add("warn", "component-name", `${file} starts with a lowercase component name`, "Use PascalCase for .tsx components.");
    }
    if (file.startsWith("hooks/") && file.endsWith(".ts") && !/^use[A-Z]/.test(base)) {
      add("warn", "hook-name", `${file} does not follow use<Name>.ts`, "Rename the hook file.");
    }
  }
}

export function reviewChanges({
  repoRoot = REPO_ROOT,
  changes,
  guides = MODULE_GUIDES,
  runCheck,
}) {
  const groups = new Map();
  for (const change of changes) {
    const entry = moduleForPath(change.path, guides);
    if (!entry) continue;
    const normalized = { ...change, path: normalize(change.path) };
    if (!groups.has(entry.guide)) groups.set(entry.guide, { guide: entry.guide, changes: [] });
    groups.get(entry.guide).changes.push(normalized);
  }

  const modules = [];
  for (const group of groups.values()) {
    const guideText = readRepoFile(repoRoot, group.guide);
    const findings = [];
    const add = (severity, rule, message, fix) =>
      findings.push({ severity, rule, message, fix });

    const changedSet = new Set(group.changes.map((change) => change.path));
    const sourceChanges = group.changes.filter(
      (change) => isSource(change.path) && change.path !== group.guide,
    );
    const reviewable = group.changes.filter(
      (change) => isReviewable(change.path) && change.path !== group.guide,
    );
    if (reviewable.length === 0) continue;

    const checks = guideText ? extractReviewChecks(guideText) : [];
    if (!guideText) {
      add("error", "guide-missing", `${group.guide} does not exist`, "Restore the module guide.");
    } else if (checks.length === 0) {
      add(
        "error",
        "checks-missing",
        `${group.guide} has no ## Review checks list`,
        "Add review checks; see AGENT_MD_SYSTEM.md.",
      );
    }

    const guideChanged = changedSet.has(group.guide);
    if (!guideChanged) {
      for (const change of sourceChanges) {
        if (change.status !== "A" && change.status !== "D") continue;
        add(
          "warn",
          "guide-drift",
          `${group.guide} was not updated after ${change.status === "A" ? "adding" : "deleting"} ${change.path}`,
          "Update the file map or contract, or explain why the guide is unchanged.",
        );
      }
    }

    const contents = new Map();
    for (const change of group.changes) {
      if (change.status === "D") continue;
      const content = readRepoFile(repoRoot, change.path);
      if (content !== null) contents.set(change.path, content);
    }

    // Rules are keyed to path classes, not guide filenames, so renaming or
    // splitting a guide does not silently disable its mechanical checks.
    const check = runCheck ?? ((script) => runRepoCheck(repoRoot, script));
    const changedFiles = group.changes.map((change) => change.path);
    checkUiGroup(contents, changedFiles, add, check);
    checkApiGroup(contents, changedFiles, add, check);
    checkToolsGroup(repoRoot, sourceChanges, contents, add);
    checkProvidersGroup(repoRoot, sourceChanges, contents, add);
    checkDbGroup(repoRoot, sourceChanges, contents, changedSet, add);
    checkStoresGroup(repoRoot, sourceChanges, contents, add);
    checkScriptsGroup(sourceChanges, contents, add);
    checkAgentsGroup(sourceChanges, contents, changedSet, add);
    checkTestsGroup(group.changes, contents, add);
    checkNaming(group.changes, add);

    modules.push({
      guide: group.guide,
      changedFiles,
      checks,
      findings,
    });
  }

  const findings = modules.flatMap((entry) => entry.findings);
  return {
    modules,
    errors: findings.filter((finding) => finding.severity === "error"),
    warnings: findings.filter((finding) => finding.severity === "warn"),
  };
}

export function formatReport(result) {
  const lines = [`[module-review] ${result.modules.length} module(s) touched`];
  for (const reviewModule of result.modules) {
    lines.push("", `=== ${reviewModule.guide} (${reviewModule.changedFiles.length} file(s)) ===`);
    if (reviewModule.checks.length > 0) {
      lines.push("Review checks:");
      for (const check of reviewModule.checks) {
        lines.push(`${" ".repeat(check.indent)}  [ ] ${check.text}`);
      }
    }
    if (reviewModule.findings.length === 0) {
      lines.push("Automated: no findings");
      continue;
    }
    lines.push("Automated:");
    for (const finding of reviewModule.findings) {
      const label = finding.severity === "error" ? "FAIL" : "WARN";
      lines.push(`  ${label} [${finding.rule}] ${finding.message}`);
      if (finding.fix) lines.push(`       fix: ${finding.fix}`);
    }
  }
  lines.push(
    "",
    `[module-review] ${result.errors.length} error(s), ${result.warnings.length} warning(s)`,
  );
  return lines.join("\n");
}

const USAGE = `Usage: node scripts/check-module-review.mjs [options]

  --staged                    review staged changes
  --base <ref> [--head <ref>] review base...head (default head: HEAD)
  --name-status-file <path>   read NUL-delimited --name-status output
  --json                      machine-readable output
  --fail-on-warnings          exit 1 when only warnings remain
  -h, --help                  show this help

Default: review the working tree against HEAD.`;

function parseArgs(argv) {
  const options = {
    staged: false,
    base: null,
    head: null,
    nameStatusFile: null,
    json: false,
    failOnWarnings: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--staged") options.staged = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--fail-on-warnings") options.failOnWarnings = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--base" || arg === "--head" || arg === "--name-status-file") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      if (arg === "--base") options.base = value;
      else if (arg === "--head") options.head = value;
      else options.nameStatusFile = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.head && !options.base) throw new Error("--head requires --base");
  const sources = [options.staged, Boolean(options.base), Boolean(options.nameStatusFile)];
  if (sources.filter(Boolean).length > 1) {
    throw new Error("choose one of --staged, --base, or --name-status-file");
  }
  return options;
}

export function loadChanges({
  staged = false,
  base = null,
  head = null,
  nameStatusFile = null,
  repoRoot = REPO_ROOT,
} = {}) {
  let raw;
  if (nameStatusFile) {
    raw = readFileSync(nameStatusFile, "utf8");
  } else {
    const range = staged ? ["--cached"] : base ? [`${base}...${head ?? "HEAD"}`] : ["HEAD"];
    raw = execFileSync("git", ["diff", "--name-status", "-z", ...range], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (!staged && !base) {
      const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return [
        ...parseNameStatus(raw),
        ...untracked
          .split("\0")
          .filter(Boolean)
          .map((file) => ({ status: "A", path: file })),
      ];
    }
  }
  return parseNameStatus(raw);
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[module-review] ${error.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  let changes;
  try {
    changes = loadChanges(options);
  } catch (error) {
    console.error(`[module-review] could not read changes: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const result = reviewChanges({ changes });
  console.log(options.json ? JSON.stringify(result, null, 2) : formatReport(result));

  if (result.errors.length > 0 || (options.failOnWarnings && result.warnings.length > 0)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main();
}
