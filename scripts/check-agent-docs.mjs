#!/usr/bin/env node
// Lint check for the modular Agent.md guidance system.
//
// AGENTS.md says agents must load the owning module's Agent.md before editing
// and keep it synchronized with the code. This script makes the documentation
// side of that contract verifiable, so drift fails `npm run lint` instead of
// slowly poisoning agent context:
//
//   1. Every declared module guide exists and has loadable frontmatter.
//   2. Every guide linked from AGENTS.md resolves.
//   3. Every repository path referenced by a guide (markdown links and inline
//      code) still exists. Code fences are ignored — examples may be sketches.
//   4. Every Agent.md found under a module root is declared here, so adding a
//      module cannot silently ship without guidance.
//
// This is a structural check, not a prose review. A passing run means the
// guide points at real files and has the fields the loader expects; it does
// not prove the described pattern is still the canonical implementation.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const SELF_PATH = url.fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..");

// Module roots that own an Agent.md. AGENTS.md links these guides; keep the
// two lists aligned. `scope` is the directory the guide governs.
export const GUIDES = [
  { guide: "AGENTS.md", scope: ".", format: "instructions" },
  { guide: "app/api/Agent.md", scope: "app/api" },
  { guide: "components/Agent.md", scope: "components" },
  { guide: "hooks/Agent.md", scope: "hooks" },
  { guide: "lib/agents/Agent.md", scope: "lib/agents" },
  { guide: "lib/db/Agent.md", scope: "lib/db" },
  { guide: "lib/mcp/Agent.md", scope: "lib/mcp" },
  { guide: "lib/providers/Agent.md", scope: "lib/providers" },
  { guide: "lib/stores/Agent.md", scope: "lib/stores" },
  { guide: "lib/tools/Agent.md", scope: "lib/tools" },
  { guide: "scripts/Agent.md", scope: "scripts" },
  { guide: "tests/Agent.md", scope: "tests" },
];

// Architecture-level documents whose relative links must keep resolving.
// CHANGELOG is excluded: it intentionally uses repository-root links.
export const ARCHITECTURE_DOCS = [
  "docs/ARCHITECTURE.md",
  "docs/DEVELOPMENT.md",
  "docs/API_DESIGN_STANDARD.md",
  "docs/EXTENDING.md",
  "docs/ui-hook-api.md",
  "packages/README.md",
];

// Directories walked when looking for undeclared Agent.md files. Workspace
// packages and the browser extension are included so a guide added there is
// registered deliberately rather than silently ignored.
const MODULE_ROOTS = [
  "app",
  "components",
  "hooks",
  "lib",
  "scripts",
  "tests",
  "packages",
  "browser-extension",
];

const REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const FILE_EXTENSIONS = /\.(md|json|jsonc|mjs|cjs|js|ts|tsx|jsx|css|scss|html|ya?ml|ps1|sh|cmd|toml)$/i;
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function fail(problems, message) {
  problems.push(message);
}

export function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return { error: "missing YAML frontmatter block" };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!field) continue;
    fields[field[1]] = field[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return { fields, body: source.slice(match[0].length) };
}

function stripFragment(target) {
  return target.split("#")[0];
}

function isLikelyRepositoryPath(token) {
  if (!token || token.length > 160) return false;
  if (/\s/.test(token)) return false;
  if (EXTERNAL_TARGET.test(token)) return false;
  if (token.startsWith("/") || token.startsWith("~")) return false; // routes, home paths
  if (/[<>{}*?|=$!(),;[\]~]/.test(token)) return false; // globs, placeholders, calls
  if (token.includes(":")) return false; // protocol or line suffix — not validated here
  if (token === "Agent.md") return false; // generic prose reference, not a path
  if (token.startsWith(".")) return false; // extension or dot-prefixed namespace
  if (token.endsWith("/")) return true; // directory reference
  if (FILE_EXTENSIONS.test(token)) return true;
  return token.includes("/") && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(token);
}

function resolveReference(repoRoot, guideDir, token, { relativeOnly = false } = {}) {
  const target = stripFragment(token).replace(/\\/g, "/");
  const candidates = path.isAbsolute(target)
    ? [target]
    : relativeOnly
      ? [path.join(guideDir, target)]
      : [path.join(repoRoot, target), path.join(guideDir, target)];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

export function extractMarkdownLinks(body) {
  const links = [];
  const pattern = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of body.matchAll(pattern)) links.push(match[1].trim());
  return links;
}

export function extractInlinePathCodes(body) {
  // Ignore fenced code blocks: examples may name files that do not exist yet.
  const withoutFences = body.replace(/^```[\s\S]*?^```\s*$/gm, "");
  const tokens = [];
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim();
    if (isLikelyRepositoryPath(token)) tokens.push(token);
  }
  return tokens;
}

export function collectAgentGuides(repoRoot) {
  const found = [];
  for (const root of MODULE_ROOTS) {
    const rootPath = path.join(repoRoot, root);
    if (!fs.existsSync(rootPath)) continue;
    found.push(...walkForAgentDocs(repoRoot, rootPath, 0));
  }
  return [...new Set(found)].sort();
}

function walkForAgentDocs(repoRoot, directory, depth) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // Find guides within two levels of a module root (top-level modules and
      // lib/<module>, app/<module>, packages/<package>). Deeper layouts are
      // ignored so a documentation folder cannot masquerade as module guidance.
      if (depth < 2) results.push(...walkForAgentDocs(repoRoot, absolute, depth + 1));
    } else if (entry.name === "Agent.md") {
      results.push(path.relative(repoRoot, absolute).replace(/\\/g, "/"));
    }
  }
  return results;
}

export function validateFrontmatter(fields, problems, label) {
  if (!fields.description) {
    fail(problems, `${label}: frontmatter needs a description`);
  } else if (!/^Use when:/i.test(fields.description)) {
    fail(problems, `${label}: description must start with "Use when:" (found "${fields.description}")`);
  }
  if (!fields.tools || !/^\[[^\]]+\]$/.test(fields.tools)) {
    fail(problems, `${label}: frontmatter needs a tools list such as [read, edit, search, execute]`);
  }
  if (!fields["reasoning-effort"]) {
    fail(problems, `${label}: frontmatter needs reasoning-effort`);
  } else if (!REASONING_EFFORTS.has(fields["reasoning-effort"])) {
    fail(
      problems,
      `${label}: reasoning-effort must be one of ${[...REASONING_EFFORTS].join(", ")}`,
    );
  }
}

export function validateGuide(repoRoot, guide, { format = "module" } = {}) {
  const problems = [];
  const guidePath = path.join(repoRoot, guide);
  if (!fs.existsSync(guidePath)) {
    fail(problems, `${guide}: file does not exist`);
    return problems;
  }
  if (!fs.existsSync(path.join(repoRoot, path.dirname(guide)))) {
    fail(problems, `${guide}: guide directory does not exist`);
  }

  const source = fs.readFileSync(guidePath, "utf8");
  let body = source;
  if (format === "module") {
    const parsed = parseFrontmatter(source);
    if (parsed.error) {
      fail(problems, `${guide}: ${parsed.error}`);
      return problems;
    }
    validateFrontmatter(parsed.fields, problems, guide);
    body = parsed.body;
  }

  const guideDir = path.dirname(guidePath);
  const links = extractMarkdownLinks(body);
  for (const link of links) {
    if (EXTERNAL_TARGET.test(link)) continue;
    // Markdown links are relative to the document, unlike inline code paths
    // which may be repository-root-relative.
    if (!resolveReference(repoRoot, guideDir, link, { relativeOnly: true })) {
      fail(problems, `${guide}: broken markdown link -> ${link}`);
    }
  }

  const inlinePaths = extractInlinePathCodes(body);
  for (const token of inlinePaths) {
    if (!resolveReference(repoRoot, guideDir, token)) {
      fail(problems, `${guide}: referenced path does not exist -> ${token}`);
    }
  }

  if (format === "module" && !/^##\s+.*(testing|validation)/im.test(body)) {
    fail(problems, `${guide}: needs a Testing or Validation section`);
  }

  return problems;
}

export function validateDocLinks(repoRoot, file) {
  const problems = [];
  const filePath = path.join(repoRoot, file);
  if (!fs.existsSync(filePath)) {
    fail(problems, `${file}: architecture document is missing`);
    return problems;
  }
  const directory = path.dirname(filePath);
  for (const link of extractMarkdownLinks(fs.readFileSync(filePath, "utf8"))) {
    if (EXTERNAL_TARGET.test(link)) continue;
    const target = stripFragment(link);
    if (!target) continue;
    if (!fs.existsSync(path.join(directory, target))) {
      fail(problems, `${file}: broken markdown link -> ${link}`);
    }
  }
  return problems;
}

export function validateAgentDocs(repoRoot = REPO_ROOT) {
  const problems = [];

  // 1. Every declared guide exists and is internally consistent.
  for (const { guide, scope, format } of GUIDES) {
    problems.push(...validateGuide(repoRoot, guide, { format }));
    if (!fs.existsSync(path.join(repoRoot, scope))) {
      fail(problems, `${guide}: declared scope does not exist -> ${scope}`);
    }
  }

  // 2. Guides linked from AGENTS.md resolve, and every declared module guide
  //    is discoverable from the root instructions.
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  if (fs.existsSync(agentsPath)) {
    const agentsBody = fs.readFileSync(agentsPath, "utf8");
    const linked = new Set();
    for (const link of extractMarkdownLinks(agentsBody)) {
      if (EXTERNAL_TARGET.test(link)) continue;
      if (!link.endsWith("Agent.md")) continue;
      const normalized = stripFragment(link).replace(/^\.\//, "");
      linked.add(normalized);
      if (!fs.existsSync(path.join(repoRoot, normalized))) {
        fail(problems, `AGENTS.md: module guide link is broken -> ${link}`);
      }
    }
    for (const { guide } of GUIDES) {
      if (guide !== "AGENTS.md" && !linked.has(guide)) {
        fail(problems, `AGENTS.md: declared module guide is not linked -> ${guide}`);
      }
    }
  }

  // 3. Architecture documents keep their cross-references current.
  for (const file of ARCHITECTURE_DOCS) {
    problems.push(...validateDocLinks(repoRoot, file));
  }

  // 4. Every Agent.md under a module root is declared (no silent orphans).
  const declared = new Set(GUIDES.map((entry) => entry.guide));
  for (const found of collectAgentGuides(repoRoot)) {
    if (!declared.has(found)) {
      fail(problems, `${found}: undeclared module guide; add it to scripts/check-agent-docs.mjs and AGENTS.md`);
    }
  }

  return { problems, guideCount: GUIDES.length, docCount: ARCHITECTURE_DOCS.length };
}

export function main() {
  const { problems, guideCount, docCount } = validateAgentDocs();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[agent-docs] ${problem}`);
    console.error(
      `[agent-docs] ${problems.length} problem(s) found in ${guideCount} module guide(s) and ${docCount} architecture document(s)`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[agent-docs] ${guideCount} module guides and ${docCount} architecture documents verified (frontmatter, links, paths, coverage)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main();
}
