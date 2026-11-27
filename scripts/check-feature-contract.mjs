#!/usr/bin/env node
// Feature-contract gate and packet generator.
//
// A feature contract is a small JSON artifact that names the modules a feature
// touches, the files each module owns, the interfaces it provides and consumes,
// and the command that validates it. Design-time validation checks that the
// contract is internally consistent. With --implemented it also checks provider
// files and symbols exist and every changed file is owned. --packets writes one
// self-contained implementation packet per module for any coding agent.
//
// Usage:
//   node scripts/check-feature-contract.mjs --contract <file>
//   node scripts/check-feature-contract.mjs --contract <file> --implemented
//   node scripts/check-feature-contract.mjs --contract <file> --staged --implemented
//   node scripts/check-feature-contract.mjs --contract <file> --base origin/main --head HEAD --implemented
//   node scripts/check-feature-contract.mjs --contract <file> --packets <dir>
//   node scripts/check-feature-contract.mjs --contract <file> --json
//
// Exit codes: 0 clean or warnings only, 1 failed checks, 2 usage error.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { loadChanges, MODULE_GUIDES, REPO_ROOT } from "./check-module-review.mjs";

const SELF_PATH = url.fileURLToPath(import.meta.url);

const MODULE_ID = /^[a-z0-9][a-z0-9-]*$/;

// Conservative triggers for "open an ADR before changing persistence schema,
// data-directory layout, or provider registration" in AGENTS.md. These are
// advisory: they prompt the lead to record a decision, not prove one is needed.
const ADR_TRIGGERS = [
  /^lib\/db\/(?:migrations|versioned-migrations|pragmas)\.ts$/,
  /^lib\/env\/app-config\.ts$/,
  /^lib\/providers\/builtins\.ts$/,
];

const normalize = (file) => file.replace(/\\/g, "/").replace(/^\.\//, "");
const isPrefix = (entry) => entry.endsWith("/");

function push(collection, severity, rule, message, fix) {
  collection.push({ severity, rule, message, ...(fix ? { fix } : {}) });
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function safePath(value) {
  const normalized = normalize(value);
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

function matchesAny(file, entries) {
  return entries.some((entry) => {
    const normalized = normalize(entry);
    if (!normalized) return false;
    if (isPrefix(normalized)) {
      return file === normalized.slice(0, -1) || file.startsWith(normalized);
    }
    return file === normalized;
  });
}

function overlaps(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return true;
  const aPrefix = isPrefix(a) ? a : `${a}/`;
  const bPrefix = isPrefix(b) ? b : `${b}/`;
  return a.startsWith(bPrefix) || b.startsWith(aPrefix);
}

function normalizeProvides(value, moduleId, errors) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const provides = [];
  value.forEach((entry, index) => {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    const file = typeof entry?.file === "string" ? normalize(entry.file.trim()) : "";
    const symbol = typeof entry?.symbol === "string" ? entry.symbol.trim() : "";
    if (!name) push(errors, "error", "provide-name", `${moduleId}.provides[${index}] needs a name`);
    if (!file) push(errors, "error", "provide-file", `${moduleId}.provides[${index}] needs a file`);
    if (file && isPrefix(file)) {
      push(errors, "error", "provide-file", `${moduleId}.provides[${index}] must name a file, not a directory`);
    }
    if (file && safePath(file) === null) {
      push(errors, "error", "provide-file", `${moduleId}.provides[${index}] has an unsafe file path`);
    }
    if (name && seen.has(name)) {
      push(errors, "error", "provide-duplicate", `${moduleId} provides ${name} more than once`);
    }
    if (name) seen.add(name);
    provides.push({ name, file, symbol: symbol || null });
  });
  return provides;
}

function normalizeConsumes(value, moduleId, errors) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const target = typeof entry?.module === "string" ? entry.module.trim() : "";
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!target) push(errors, "error", "consume-module", `${moduleId}.consumes[${index}] needs a module`);
    if (!name) push(errors, "error", "consume-name", `${moduleId}.consumes[${index}] needs a name`);
    return { module: target, name };
  });
}

function normalizeModule(entry, index, repoRoot, errors) {
  const id = typeof entry?.id === "string" ? entry.id.trim() : "";
  if (!MODULE_ID.test(id)) {
    push(errors, "error", "module-id", `modules[${index}].id must match ${MODULE_ID}`, "Use a lowercase slug such as stores.");
  }
  const guide = typeof entry?.guide === "string" ? normalize(entry.guide.trim()) : "";
  if (!guide) {
    push(errors, "error", "module-guide", `modules[${index}] is missing guide`, "Point at the owning Agent.md.");
  } else if (!MODULE_GUIDES.some((known) => known.guide === guide)) {
    push(errors, "error", "module-guide", `${id || `modules[${index}]`} uses unknown guide ${guide}`, "Use a declared module guide.");
  } else if (!existsSync(path.join(repoRoot, guide))) {
    push(errors, "error", "module-guide", `${id || `modules[${index}]`} guide ${guide} does not exist`);
  }

  const owns = stringList(entry?.owns).map(normalize);
  if (owns.length === 0) {
    push(errors, "error", "module-owns", `${id || `modules[${index}]`} must declare owns paths`, "List the files or directories this module owns.");
  }
  for (const owned of owns) {
    if (safePath(owned) === null) {
      push(errors, "error", "module-owns", `${id || `modules[${index}]`} has an unsafe path ${owned}`, "Use a repository-relative path without '..'.");
    }
  }

  const provides = normalizeProvides(entry?.provides, id || `modules[${index}]`, errors);
  const consumes = normalizeConsumes(entry?.consumes, id || `modules[${index}]`, errors);
  const validation = stringList(entry?.validation);
  if (validation.length === 0) {
    push(errors, "error", "module-validation", `${id || `modules[${index}]`} must declare validation commands`, "Name the test or gate that proves this module.");
  }
  return { id, guide, owns, provides, consumes, validation };
}

function checkDuplicateModules(modules, errors) {
  const seen = new Set();
  for (const entry of modules) {
    if (seen.has(entry.id)) {
      push(errors, "error", "module-duplicate", `module id ${entry.id} is declared more than once`);
    }
    seen.add(entry.id);
  }
}

function checkInterfaces(modules, errors) {
  const byId = new Map(modules.map((entry) => [entry.id, entry]));
  for (const entry of modules) {
    for (const consume of entry.consumes) {
      const target = byId.get(consume.module);
      if (!target) {
        push(errors, "error", "consume-unresolved", `${entry.id} consumes ${consume.module}.${consume.name}, but module ${consume.module} is not declared`, "Add the provider module or fix the reference.");
        continue;
      }
      if (!target.provides.some((provide) => provide.name === consume.name)) {
        push(errors, "error", "consume-unresolved", `${entry.id} consumes ${consume.module}.${consume.name}, but that interface is not provided`, "Declare it in provides or fix the reference.");
      }
    }
  }
}

function checkOwnership(modules, shared, errors) {
  for (let leftIndex = 0; leftIndex < modules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < modules.length; rightIndex += 1) {
      for (const left of modules[leftIndex].owns) {
        for (const right of modules[rightIndex].owns) {
          if (overlaps(left, right)) {
            push(errors, "error", "ownership-overlap", `${modules[leftIndex].id} and ${modules[rightIndex].id} both own ${left} / ${right}`, "Give each file one owner.");
          }
        }
      }
    }
  }
  for (const entry of shared) {
    for (const owner of modules) {
      for (const owned of owner.owns) {
        if (overlaps(entry, owned)) {
          push(errors, "error", "shared-overlap", `shared path ${entry} overlaps ${owner.id} ownership ${owned}`, "Keep lead-owned shared files outside module-owned paths.");
        }
      }
    }
  }
}

function checkAdr(contract, repoRoot, changed, errors, warnings) {
  if (contract.adrRequired !== undefined && typeof contract.adrRequired !== "boolean") {
    push(errors, "error", "adr-required", "adrRequired must be a boolean");
  }
  const adr = typeof contract.adr === "string" ? normalize(contract.adr.trim()) : "";
  if (contract.adrRequired === true) {
    if (!adr) {
      push(errors, "error", "adr-missing", "adrRequired is true but adr is empty", "Link the accepted ADR under docs/adr/.");
    } else if (!adr.startsWith("docs/adr/") || !adr.endsWith(".md")) {
      push(errors, "error", "adr-path", `adr must be a docs/adr/*.md path, got ${adr}`);
    } else if (!existsSync(path.join(repoRoot, adr))) {
      push(errors, "error", "adr-file", `ADR ${adr} does not exist`);
    }
  } else if (adr && !existsSync(path.join(repoRoot, adr))) {
    push(errors, "error", "adr-file", `ADR ${adr} does not exist`);
  }
  if (
    contract.adrRequired !== true &&
    changed.some((file) => ADR_TRIGGERS.some((pattern) => pattern.test(file)))
  ) {
    push(warnings, "warn", "adr-trigger", "changed files touch persistence, the data directory, or provider registration; confirm whether an ADR is required", "Set adrRequired/adr or record why the existing decision still applies.");
  }
}

function checkImplemented(repoRoot, modules, shared, changed, errors) {
  for (const change of changed) {
    const owners = modules.filter((entry) => matchesAny(change.path, entry.owns));
    const leadOwned = matchesAny(change.path, shared);
    if (owners.length > 1) {
      push(errors, "error", "ambiguous-owner", `${change.path} is owned by ${owners.map((entry) => entry.id).join(", ")}`, "Give each file one owner.");
    } else if (owners.length === 0 && !leadOwned) {
      push(errors, "error", "unowned-change", `${change.path} is not owned by any module or shared path`, "Assign it to exactly one module or the lead-owned shared list.");
    }
  }

  for (const entry of modules) {
    for (const provide of entry.provides) {
      if (!provide.file) continue;
      if (!matchesAny(provide.file, entry.owns)) {
        push(errors, "error", "provide-not-owned", `${entry.id} provides ${provide.name} from ${provide.file}, which it does not own`);
      }
      const absolute = path.join(repoRoot, provide.file);
      if (!existsSync(absolute)) {
        push(errors, "error", "provide-missing", `${entry.id} provides ${provide.name} from ${provide.file}, but the file does not exist`);
        continue;
      }
      if (provide.symbol && !readFileSync(absolute, "utf8").includes(provide.symbol)) {
        push(errors, "error", "provide-symbol", `${entry.id} provides ${provide.name}, but ${provide.symbol} does not appear in ${provide.file}`, "Update the symbol or the contract.");
      }
    }
  }
}

function changedPaths(changes, excludes) {
  const seen = new Set();
  const result = [];
  for (const change of changes) {
    const file = normalize(change.path);
    if (seen.has(file)) continue;
    if (excludes.some((entry) => matchesAny(file, [entry]))) continue;
    seen.add(file);
    result.push({ status: change.status, path: file });
  }
  return result;
}

function repoRelative(repoRoot, file) {
  if (!file) return null;
  const relative = path.relative(repoRoot, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return normalize(relative);
}

export function validateContract({
  repoRoot = REPO_ROOT,
  contract,
  changes = [],
  implemented = false,
  ignores = [],
  contractFile = null,
} = {}) {
  const errors = [];
  const warnings = [];
  const modules = [];
  const shared = [];

  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    push(errors, "error", "contract-shape", "contract must be a JSON object");
    return { feature: "", title: null, modules, shared, changedFiles: [], errors, warnings };
  }
  if (contract.schemaVersion !== 1) {
    push(errors, "error", "contract-version", "schemaVersion must be 1");
  }
  if (typeof contract.feature !== "string" || contract.feature.trim() === "") {
    push(errors, "error", "contract-feature", "feature must be a non-empty string");
  }
  if (!Array.isArray(contract.modules) || contract.modules.length === 0) {
    push(errors, "error", "contract-modules", "modules must be a non-empty array");
  } else {
    contract.modules.forEach((entry, index) =>
      modules.push(normalizeModule(entry, index, repoRoot, errors)),
    );
  }

  for (const entry of stringList(contract.shared).map(normalize)) {
    if (safePath(entry) === null) {
      push(errors, "error", "shared-path", `shared path ${entry} is not repository-relative`);
    } else {
      shared.push(entry);
    }
  }

  checkDuplicateModules(modules, errors);
  checkOwnership(modules, shared, errors);
  checkInterfaces(modules, errors);

  const excludes = [contractFile, ...ignores].filter(Boolean);
  const changedFiles = changedPaths(changes, excludes);
  checkAdr(contract, repoRoot, changedFiles.map((change) => change.path), errors, warnings);
  if (implemented) checkImplemented(repoRoot, modules, shared, changedFiles, errors);

  return {
    feature: typeof contract.feature === "string" ? contract.feature.trim() : "",
    title: typeof contract.title === "string" ? contract.title.trim() : null,
    modules,
    shared,
    changedFiles,
    errors,
    warnings,
  };
}

export function formatReport(result) {
  const lines = [
    `[feature-contract] feature: ${result.feature || "(unnamed)"}`,
    `[feature-contract] modules: ${result.modules.length}; changed files: ${result.changedFiles.length}`,
  ];
  if (result.modules.length > 0) {
    lines.push("[feature-contract] module ownership:");
    for (const entry of result.modules) {
      lines.push(`  - ${entry.id} (${entry.guide})`);
    }
  }
  const findings = [...result.errors, ...result.warnings];
  if (findings.length === 0) {
    lines.push("[feature-contract] PASS: contract is consistent.");
    return lines.join("\n");
  }
  lines.push("Automated:");
  for (const finding of findings) {
    const label = finding.severity === "error" ? "FAIL" : "WARN";
    lines.push(`  ${label} [${finding.rule}] ${finding.message}`);
    if (finding.fix) lines.push(`       fix: ${finding.fix}`);
  }
  lines.push(
    "",
    `[feature-contract] ${result.errors.length} error(s), ${result.warnings.length} warning(s)`,
  );
  return lines.join("\n");
}

export function formatPacket(entry, contract, shared = []) {
  const slice = {
    feature: contract.feature,
    title: contract.title ?? null,
    guide: entry.guide,
    owns: entry.owns,
    provides: entry.provides,
    consumes: entry.consumes,
    validation: entry.validation,
    shared,
  };
  return [
    `# Implementation packet: ${entry.id}`,
    "",
    `Feature: ${contract.feature}`,
    `Guide: \`${entry.guide}\``,
    "",
    "## Owned files",
    "",
    ...entry.owns.map((file) => `- \`${file}\``),
    "",
    "## Provides",
    "",
    ...(entry.provides.length > 0
      ? entry.provides.map(
          (provide) =>
            `- \`${provide.name}\` — \`${provide.file}\`${provide.symbol ? ` (symbol \`${provide.symbol}\`)` : ""}`,
        )
      : ["None."]),
    "",
    "## Consumes",
    "",
    ...(entry.consumes.length > 0
      ? entry.consumes.map((consume) => `- \`${consume.module}.${consume.name}\``)
      : ["None."]),
    "",
    "## Validation",
    "",
    ...entry.validation.map((command) => `- \`${command}\``),
    "",
    "## Shared files (lead-owned; do not edit)",
    "",
    ...(shared.length > 0 ? shared.map((file) => `- \`${file}\``) : ["None."]),
    "",
    "## Task",
    "",
    "Implement this module's slice of the feature. Read `AGENTS.md` and the guide before inspecting code. Do not edit files outside Owned files. If the contract is wrong or incomplete, stop and report a contract-change request with evidence; do not invent a different interface.",
    "",
    "## Contract slice",
    "",
    "```json",
    JSON.stringify(slice, null, 2),
    "```",
    "",
    "## Output contract",
    "",
    "Report a summary, files changed, commands run with their output, blockers, and any contract-change requests. Do not claim a test passed without its command output.",
  ].join("\n");
}

export function writePackets(directory, contract, modules, shared = []) {
  if (modules.length === 0) return [];
  const absolute = path.resolve(directory);
  mkdirSync(absolute, { recursive: true });
  const written = [];
  for (const entry of modules) {
    const file = path.join(absolute, `${entry.id}.packet.md`);
    writeFileSync(file, `${formatPacket(entry, contract, shared)}\n`, "utf8");
    written.push(file);
  }
  return written;
}

const USAGE = `Usage: node scripts/check-feature-contract.mjs --contract <file> [options]

  --contract <file>             feature contract JSON (required)
  --implemented                 verify provider files/symbols and changed-file ownership
  --staged                      verify staged changes
  --base <ref> [--head <ref>]   verify a base...head range (default head: HEAD)
  --packets <dir>               write one implementation packet per module
  --ignore <path-or-prefix>     ignore a changed path (repeatable; use dir/ for a tree)
  --json                        machine-readable output
  -h, --help                    show this help

Default: design-time validation. --implemented with no range uses the working tree against HEAD.`;

function parseArgs(argv) {
  const options = {
    contract: null,
    implemented: false,
    staged: false,
    base: null,
    head: null,
    packets: null,
    ignore: [],
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--implemented") options.implemented = true;
    else if (arg === "--staged") options.staged = true;
    else if (arg === "--json") options.json = true;
    else if (
      arg === "--contract" ||
      arg === "--base" ||
      arg === "--head" ||
      arg === "--packets" ||
      arg === "--ignore"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      if (arg === "--contract") options.contract = value;
      else if (arg === "--base") options.base = value;
      else if (arg === "--head") options.head = value;
      else if (arg === "--packets") options.packets = value;
      else options.ignore.push(value);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.help && !options.contract) throw new Error("--contract is required");
  if (options.head && !options.base) throw new Error("--head requires --base");
  if (options.staged && options.base) throw new Error("--staged cannot be combined with --base/--head");
  return options;
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[feature-contract] ${error.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  let contract;
  try {
    contract = JSON.parse(readFileSync(path.resolve(options.contract), "utf8"));
  } catch (error) {
    console.error(`[feature-contract] could not read contract: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  let changes = [];
  if (options.implemented || options.staged || options.base) {
    try {
      changes = loadChanges({ staged: options.staged, base: options.base, head: options.head });
    } catch (error) {
      console.error(`[feature-contract] could not read changes: ${error.message}`);
      process.exitCode = 2;
      return;
    }
  }

  const ignores = [...options.ignore];
  const packetPrefix = repoRelative(REPO_ROOT, options.packets);
  if (packetPrefix) ignores.push(`${packetPrefix.replace(/\/+$/, "")}/`);

  const result = validateContract({
    contract,
    changes,
    implemented: options.implemented,
    ignores,
    contractFile: repoRelative(REPO_ROOT, options.contract),
  });

  let packetFiles = [];
  if (options.packets && result.errors.length === 0) {
    try {
      packetFiles = writePackets(options.packets, contract, result.modules, result.shared);
    } catch (error) {
      console.error(`[feature-contract] could not write packets: ${error.message}`);
      process.exitCode = 2;
      return;
    }
  } else if (options.packets) {
    console.error(
      "[feature-contract] refusing to write packets while the contract has errors",
    );
  }

  const output = options.packets ? { ...result, packets: packetFiles } : result;
  console.log(options.json ? JSON.stringify(output, null, 2) : formatReport(result));
  if (!options.json && packetFiles.length > 0) {
    console.log(
      "",
      `[feature-contract] wrote ${packetFiles.length} packet(s) to ${path.resolve(options.packets)}`,
    );
    for (const file of packetFiles) console.log(`  ${file}`);
  }

  if (result.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main();
}
