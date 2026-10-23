import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const GENERATED = new Set([
  "CHANGELOG.md",
  "docs/adoption/changesets.json",
  "docs/adoption/surface-snapshot.json",
]);

export function documentationPath(file) {
  if (file.split("/").some((part) => part.startsWith("."))) return false;
  return /^(README|CONTRIBUTING)\.md$/.test(file)
    || /^docs\/(?!releases\/)[a-zA-Z0-9_./-]+\.md$/.test(file)
    || /^packages\/[a-zA-Z0-9_-]+\/README\.md$/.test(file);
}

export function reviewPath(version) {
  if (!VERSION.test(version)) throw new Error(`Invalid stable release version: ${version}`);
  return `docs/releases/${version}.json`;
}

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function versionOnlyChange(before, after) {
  const normalize = (value) => {
    const copy = structuredClone(value);
    delete copy.version;
    if (copy.packages?.[""]) delete copy.packages[""].version;
    return copy;
  };
  return isDeepStrictEqual(normalize(before), normalize(after));
}

export function validateRecord(record, context) {
  if (!record || record.schemaVersion !== 1 || record.version !== context.version
    || record.previousTag !== context.previousTag || !SHA.test(record.reviewedSha ?? "")) {
    throw new Error("Documentation review has an invalid schema, version, previous tag, or reviewed SHA");
  }
  if (!["updated", "unnecessary"].includes(record.decision)) {
    throw new Error("Documentation decision must be updated or unnecessary");
  }
  if (typeof record.rationale !== "string" || record.rationale.trim().length < 30) {
    throw new Error("Documentation review needs a substantive rationale (at least 30 characters)");
  }
  if (!Array.isArray(record.documentation)
    || record.documentation.some((file) => typeof file !== "string" || !documentationPath(file))
    || new Set(record.documentation).size !== record.documentation.length) {
    throw new Error("Documentation review must list unique documentation paths");
  }
  if ((record.decision === "updated") !== (record.documentation.length > 0)) {
    throw new Error("Updated reviews must list documentation; unnecessary reviews must list none");
  }
}

export function repository(cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: "pipe", maxBuffer: 16 * 1024 * 1024,
  }).trim();
  const jsonAt = (ref, file) => JSON.parse(git("show", `${ref}:${file}`));
  const changed = (base, head) => git("diff", "--name-only", "--no-renames", "-z", base, head).split("\0").filter(Boolean);
  const ancestor = (base, head) => git("merge-base", "--is-ancestor", base, head);
  const commit = (ref) => {
    // Resolve only explicit commit-ish arguments, never git options.
    return git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  };

  function context(version, ref = "HEAD") {
    reviewPath(version);
    const reviewedSha = commit(ref);
    const previousTag = git("tag", "--merged", reviewedSha, "--list", "v*").split(/\r?\n/)
      .filter((tag) => VERSION.test(tag.slice(1)) && compareVersions(tag.slice(1), version) < 0)
      .sort((a, b) => compareVersions(b.slice(1), a.slice(1)))[0];
    if (!previousTag) throw new Error(`No previous reachable stable tag found before ${version}`);
    const currentVersion = jsonAt(reviewedSha, "package.json").version;
    if (!VERSION.test(currentVersion) || compareVersions(version, currentVersion) < 0) {
      throw new Error(`Requested version ${version} is older than source version ${currentVersion}`);
    }
    return { version, previousTag, reviewedSha };
  }

  function check(version, ref = "HEAD") {
    const expected = context(version, ref);
    const record = jsonAt(expected.reviewedSha, reviewPath(version));
    validateRecord(record, expected);
    ancestor(record.reviewedSha, expected.reviewedSha);
    ancestor(commit(expected.previousTag), record.reviewedSha);
    for (const file of changed(record.reviewedSha, expected.reviewedSha)) {
      if (file === reviewPath(version) || documentationPath(file) || GENERATED.has(file)) continue;
      if (["package.json", "package-lock.json"].includes(file)
        && versionOnlyChange(jsonAt(record.reviewedSha, file), jsonAt(expected.reviewedSha, file))) continue;
      throw new Error(`Documentation review is stale: unreviewed source change in ${file}`);
    }
    const documentedChanges = new Set(changed(commit(expected.previousTag), expected.reviewedSha));
    for (const file of record.documentation) {
      if (!documentedChanges.has(file)) throw new Error(`Listed documentation was not changed since ${expected.previousTag}: ${file}`);
      if (!git("ls-tree", expected.reviewedSha, "--", file).startsWith("100644 blob ")) {
        throw new Error(`Listed documentation must exist as a regular file: ${file}`);
      }
    }
    return record;
  }

  function checkProposal(version, sourceRef) {
    const expected = context(version, sourceRef);
    const files = git("diff", "--name-only", "--no-renames", "-z", expected.reviewedSha)
      .split("\0").filter(Boolean);
    const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
    for (const file of new Set([...files, ...untracked])) {
      if (file !== reviewPath(version) && !documentationPath(file)) {
        throw new Error(`Copilot proposal changed a non-documentation path: ${file}`);
      }
      if (!lstatSync(resolve(cwd, file)).isFile()) throw new Error(`Proposal output must be a regular file: ${file}`);
    }
    const record = JSON.parse(readFileSync(resolve(cwd, reviewPath(version)), "utf8"));
    validateRecord(record, expected);
    if (record.reviewedSha !== expected.reviewedSha) throw new Error("Copilot review does not match the requested source SHA");
    return expected;
  }

  function checkPullRequest(baseRef, headRef = "HEAD") {
    const base = commit(baseRef);
    const head = commit(headRef);
    const files = changed(base, head);
    for (const file of files.filter((file) => /^docs\/releases\/.*\.json$/.test(file))) {
      const version = file.slice("docs/releases/".length, -".json".length);
      check(version, head);
    }
    const version = jsonAt(head, "package.json").version;
    if (version !== jsonAt(base, "package.json").version) check(version, head);
  }

  return { context, check, checkProposal, checkPullRequest };
}

export function renderDocumentationPrompt(context) {
  return `${readFileSync(new URL("./prompts/release-docs.txt", import.meta.url), "utf8")}\n\nRelease input:\n${JSON.stringify(context, null, 2)}\n`;
}

function main() {
  const [command, version, ref] = process.argv.slice(2);
  const repo = repository();
  if (command === "context") console.log(JSON.stringify(repo.context(version, ref)));
  else if (command === "prompt") process.stdout.write(renderDocumentationPrompt(repo.context(version, ref)));
  else if (command === "check") {
    repo.check(version, ref);
    console.log(`Documentation review verified for ${version}`);
  } else if (command === "proposal") {
    repo.checkProposal(version, ref);
    console.log(`Documentation proposal scope verified for ${version}`);
  } else if (command === "pr") repo.checkPullRequest(version, ref);
  else throw new Error("Usage: release-docs.mjs context|prompt|check|proposal <version> [ref], or pr <base> [head]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`Documentation gate: ${error.message}`);
    console.error("Run the on-demand Release documentation workflow, review and merge its PR, then retry the release. Do not bypass the gate.");
    process.exitCode = 1;
  }
}
