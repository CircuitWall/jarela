#!/usr/bin/env node
// Release-bump helper invoked by `make bump`.
//
// Reads commits since the last `vX.Y.Z` tag, picks the largest bump level
// triggered by Conventional-Commits prefixes (feat! / fix! / BREAKING CHANGE
// → MAJOR; feat: → MINOR; else PATCH), bumps `package.json`, and promotes
// `[Unreleased]` in CHANGELOG.md under a dated heading. Leaves the changes
// uncommitted so the user can review and open the release PR per
// CONTRIBUTING.md.
//
// Pre-1.0 semver caveat from CONTRIBUTING.md: while the version is below
// 1.0.0, MAJOR-triggering commits bump MINOR rather than MAJOR.
//
// Override the auto-detection with `VERSION=1.2.3 make bump`.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const PKG_PATH = join(REPO, "package.json");
const CHANGELOG_PATH = join(REPO, "CHANGELOG.md");

function git(...args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

function lastVersionTag() {
  const tags = git("tag", "--list", "v*", "--sort=-version:refname")
    .split("\n")
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  return tags[0] ?? null;
}

function commitsSince(tag) {
  // Parent of the tag, then HEAD. Returns subject lines + commit body so the
  // BREAKING CHANGE: footer is matchable.
  const range = tag ? `${tag}..HEAD` : "HEAD";
  return git("log", range, "--format=%B%x1e").split("\x1e").map((s) => s.trim()).filter(Boolean);
}

function detectBump(commits) {
  let level = "patch";
  for (const c of commits) {
    const subject = c.split("\n", 1)[0];
    // feat! / fix! / chore! / etc. — `<type>(scope)?!:`
    if (/^[a-z]+(\([^)]+\))?!:/.test(subject) || /\bBREAKING CHANGE:/.test(c)) {
      return "major";
    }
    if (/^feat(\([^)]+\))?:/.test(subject)) {
      level = "minor";
    }
  }
  return level;
}

function bumpVersion(current, level, prerelease) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`Unparseable version "${current}" in package.json`);
  let [_, M, mi, p] = m;
  M = +M; mi = +mi; p = +p;
  // Pre-1.0 caveat: MAJOR bump becomes MINOR until 1.0.0 ships.
  const effective = prerelease && level === "major" ? "minor" : level;
  if (effective === "major") return `${M + 1}.0.0`;
  if (effective === "minor") return `${M}.${mi + 1}.0`;
  return `${M}.${mi}.${p + 1}`;
}

function rewritePackageJson(next) {
  const raw = fs.readFileSync(PKG_PATH, "utf8");
  const updated = raw.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${next}$2`);
  if (updated === raw) throw new Error("package.json: no version field rewritten");
  fs.writeFileSync(PKG_PATH, updated);
}

function rewriteChangelog(next) {
  const raw = fs.readFileSync(CHANGELOG_PATH, "utf8");
  const today = new Date().toISOString().slice(0, 10);
  // Insert `## [next] - today` immediately after the [Unreleased] heading.
  // Don't touch anything inside [Unreleased] — those entries become the new
  // version's body, and a fresh empty [Unreleased] sits above them.
  const unreleasedRe = /^## \[Unreleased\]\s*$/m;
  if (!unreleasedRe.test(raw)) {
    throw new Error("CHANGELOG.md: `## [Unreleased]` heading not found");
  }
  const updated = raw.replace(
    unreleasedRe,
    `## [Unreleased]\n\n## [${next}] - ${today}`,
  );
  if (updated === raw) throw new Error("CHANGELOG.md: rewrite produced no change");
  fs.writeFileSync(CHANGELOG_PATH, updated);
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  const current = pkg.version;
  const override = process.env.VERSION;

  const tag = lastVersionTag();
  const tagVersion = tag ? tag.replace(/^v/, "") : null;
  if (tagVersion && tagVersion !== current) {
    console.warn(`[bump] note: package.json (${current}) is ahead of the last tag (${tag}). The previous release may not have been tagged yet.`);
  }

  let next;
  if (override) {
    if (!/^\d+\.\d+\.\d+$/.test(override)) {
      console.error(`[bump] VERSION="${override}" must be MAJOR.MINOR.PATCH`);
      process.exit(2);
    }
    next = override;
  } else {
    const commits = commitsSince(tag);
    if (commits.length === 0) {
      console.error(`[bump] no commits since ${tag ?? "the start of history"} — nothing to bump`);
      process.exit(2);
    }
    const level = detectBump(commits);
    const prerelease = current.startsWith("0.");
    next = bumpVersion(current, level, prerelease);
    console.log(`[bump] commits since ${tag ?? "init"}: ${commits.length} → ${level}${prerelease && level === "major" ? " (clamped to minor pre-1.0)" : ""}`);
  }

  if (next === current) {
    console.error(`[bump] computed version ${next} == current ${current} — nothing to do`);
    process.exit(2);
  }

  rewritePackageJson(next);
  rewriteChangelog(next);

  console.log(`[bump] ${current} → ${next}`);
  console.log("[bump] package.json + CHANGELOG.md updated; review and commit:");
  console.log(`        git checkout -b chore/release-${next}`);
  console.log(`        git add package.json CHANGELOG.md`);
  console.log(`        git commit -m "chore(release): bump to ${next}"`);
  console.log("        gh pr create --title \"chore(release): bump to " + next + "\"");
}

main();
