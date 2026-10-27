import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = ["feat", "fix", "refactor", "perf", "docs", "test", "build", "ci", "chore", "other"];
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock)$/;

export function collectHistory(root) {
  const git = (...args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
  });
  if (git("rev-parse", "--is-shallow-repository").trim() !== "false") {
    throw new Error("Project history requires a full checkout. Run git fetch --unshallow --tags before building docs.");
  }
  const commits = [];
  let current;
  const raw = git("log", "HEAD", "--no-merges", "--numstat", "--format=%x1e%H%x09%cI%x09%s", "--no-renames");
  for (const line of raw.split("\n")) {
    if (line.startsWith("\x1e")) {
      const [hash, date, subject] = line.slice(1).split("\t");
      assert(/^[a-f0-9]{40,64}$/.test(hash) && Number.isFinite(Date.parse(date)), "Invalid Git commit metadata");
      const match = /^([a-z]+)(?:\([^)]*\))?!?:\s/i.exec(subject);
      const type = match && TYPES.includes(match[1].toLowerCase()) ? match[1].toLowerCase() : "other";
      current = { hash: hash.slice(0, 10), date, type, added: 0, deleted: 0, lockAdded: 0, lockDeleted: 0, binary: 0 };
      commits.push(current);
    } else if (line.trim()) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      assert(match && current, "Unexpected Git numstat record");
      const [, added, deleted, filename] = match;
      if (added === "-") {
        assert.equal(deleted, "-");
        current.binary++;
        continue;
      }
      assert.notEqual(deleted, "-");
      current.added += Number(added);
      current.deleted += Number(deleted);
      // Git quotes unusual paths; only a recognized basename is needed here.
      if (LOCKFILE.test(filename.replace(/^"|"$/g, ""))) {
        current.lockAdded += Number(added);
        current.lockDeleted += Number(deleted);
      }
    }
  }
  commits.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.hash.localeCompare(b.hash));
  assert.equal(commits.length, Number(git("rev-list", "--count", "--no-merges", "HEAD").trim()));
  assert(commits.length > 0, "Project history requires at least one non-merge commit");
  const reachable = new Set(git("rev-list", "HEAD").trim().split("\n"));
  const releases = [];
  const taggedCommits = new Set();
  const tags = git("tag", "--list").trim().split("\n").filter(name => /^v?\d+\.\d+\.\d+$/.test(name));
  for (const name of tags) {
    const hash = git("rev-parse", `${name}^{commit}`).trim();
    if (!reachable.has(hash)) continue;
    if (taggedCommits.has(hash)) continue;
    const date = git("show", "-s", "--format=%cI", hash).trim();
    assert(Number.isFinite(Date.parse(date)), "Invalid Git release date");
    releases.push({ name, date });
    taggedCommits.add(hash);
  }
  releases.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.name.localeCompare(b.name, "en", { numeric: true }));
  const independent = git("log", "HEAD", "--no-merges", "--shortstat", "--format=", "--no-renames");
  const added = [...independent.matchAll(/(\d+) insertions?\(\+\)/g)].reduce((n, m) => n + Number(m[1]), 0);
  const deleted = [...independent.matchAll(/(\d+) deletions?\(-\)/g)].reduce((n, m) => n + Number(m[1]), 0);
  assert.equal(commits.reduce((n, c) => n + c.added, 0), added);
  assert.equal(commits.reduce((n, c) => n + c.deleted, 0), deleted);
  return {
    repository: "CircuitWall/jarela",
    head: git("rev-parse", "--short=10", "HEAD").trim(),
    generated: git("show", "-s", "--format=%cI", "HEAD").trim(),
    merges: Number(git("rev-list", "--count", "--merges", "HEAD").trim()),
    commits, releases, types: TYPES,
  };
}

export function generateProjectHistory(root) {
  const data = collectHistory(root);
  const template = readFileSync(new URL("./project-history.template.html", import.meta.url), "utf8");
  assert.equal(template.split("__HISTORY_DATA__").length, 2, "History template needs exactly one data placeholder");
  const html = template.replace("__HISTORY_DATA__", () => JSON.stringify(data).replace(/</g, "\\u003c"));
  const output = path.join(root, "docs", "assets", "project-history.html");
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, html);
  console.log(`Generated project history: ${data.commits.length} commits, ${data.releases.length} reachable releases.`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateProjectHistory(process.cwd());
}
