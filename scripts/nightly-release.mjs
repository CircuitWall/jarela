import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAIN_REF = "origin/main";

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`Invalid stable semver version: ${value}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function nextVersion(version, bump) {
  const parsed = parseVersion(version);
  if (bump === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function breakingCommit(commit) {
  return /^[a-z]+(?:\([^)]+\))?!:/i.test(commit.subject)
    || /^BREAKING[ -]CHANGE\s*:/im.test(commit.body);
}

function featureCommit(commit) {
  return /^feat(?:\([^)]+\))?:/i.test(commit.subject);
}

export function releaseCommitMatchesBase(commit, parentSha) {
  const releaseBase = /^Release base: ([0-9a-f]{40})$/m.exec(commit?.body ?? "")?.[1];
  return Boolean(releaseBase && releaseBase === parentSha);
}

export function classifyRelease({ currentVersion, latestTag, commits }) {
  if (commits.length === 0) return { action: "none", version: currentVersion, latestTag };

  const tagVersion = latestTag.replace(/^v/, "");
  if (currentVersion !== tagVersion) {
    const releaseSubject = `chore(release): bump to ${currentVersion}`;
    const releaseCommit = commits.find((commit) => commit.subject === releaseSubject);
    if (releaseCommit && compareVersions(currentVersion, tagVersion) > 0) {
      return {
        action: "resume",
        version: currentVersion,
        targetSha: releaseCommit.sha,
        latestTag,
      };
    }
    return {
      action: "manual",
      reason: "main-version-mismatch",
      version: currentVersion,
      latestTag,
    };
  }

  const breakingCommits = commits.filter(breakingCommit);
  if (breakingCommits.length > 0) {
    return {
      action: "manual",
      reason: "breaking-change",
      version: currentVersion,
      latestTag,
      breakingCommits: breakingCommits.map(({ subject }) => subject),
    };
  }

  const featureCount = commits.filter(featureCommit).length;
  const bump = featureCount >= 3 ? "minor" : "patch";
  return {
    action: "release",
    bump,
    version: nextVersion(currentVersion, bump),
    currentVersion,
    latestTag,
    featureCount,
    commitCount: commits.length,
    commits,
  };
}

function changelogCategory(type) {
  if (type === "feat") return "Added";
  if (type === "fix" || type === "perf") return "Fixed";
  return "Changed";
}

function changelogDescription(subject) {
  const match = /^[a-z]+(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(subject);
  const description = match?.[2] ?? subject;
  return `${match?.[1] ? `${match[1]}: ` : ""}${description.charAt(0).toUpperCase()}${description.slice(1)}`;
}

export function renderReleaseNotes(commits) {
  const groups = new Map([["Added", []], ["Fixed", []], ["Changed", []]]);
  for (const commit of commits) {
    const type = /^([a-z]+)/i.exec(commit.subject)?.[1]?.toLowerCase() ?? "changed";
    groups.get(changelogCategory(type)).push(`- ${changelogDescription(commit.subject)}`);
  }
  return [...groups]
    .filter(([, entries]) => entries.length > 0)
    .map(([heading, entries]) => `### ${heading}\n\n${entries.join("\n")}`)
    .join("\n\n");
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function getLatestTag() {
  const tags = git("tag", "--merged", MAIN_REF, "--list", "v*")
    .split(/\r?\n/)
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  tags.sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
  if (!tags[0]) throw new Error("No reachable vX.Y.Z release tag found on main");
  return tags[0];
}

function readCommits(range) {
  const log = git("log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", range);
  return log.split("\x1e").filter(Boolean).map((record) => {
    const [sha = "", subject = "", ...body] = record.split("\x1f");
    return { sha, subject, body: body.join("\x1f").trim() };
  });
}

export function createPlan({ currentVersion, latestTag, commits }) {
  return classifyRelease({ currentVersion, latestTag, commits });
}

function calculatePlan() {
  const latestTag = getLatestTag();
  const mainSha = git("rev-parse", MAIN_REF);
  const packageJson = JSON.parse(git("show", `${MAIN_REF}:package.json`));
  const commits = readCommits(`${latestTag}..${MAIN_REF}`);
  const plan = createPlan({
    currentVersion: packageJson.version,
    latestTag,
    commits,
  });
  if (plan.action === "resume") {
    const releaseCommit = commits.find((commit) => commit.sha === plan.targetSha);
    const releaseParent = git("rev-parse", `${plan.targetSha}^`).split(/\s+/)[0];
    if (!releaseCommitMatchesBase(releaseCommit, releaseParent)) {
      return { action: "manual", reason: "release-base-advanced", version: packageJson.version, latestTag, mainSha };
    }
  }
  return { ...plan, mainSha };
}

function writePlan(plan) {
  const outputs = [
    `action=${plan.action}`,
    `version=${plan.version ?? ""}`,
    `bump=${plan.bump ?? ""}`,
    `latest_tag=${plan.latestTag ?? ""}`,
    `main_sha=${plan.mainSha ?? ""}`,
    `target_sha=${plan.targetSha ?? ""}`,
    `feature_count=${plan.featureCount ?? 0}`,
    `reason=${plan.reason ?? ""}`,
  ].join("\n") + "\n";

  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
  else process.stdout.write(outputs);

  if (!process.env.GITHUB_STEP_SUMMARY) return;
  let summary;
  if (plan.action === "release") {
    summary = `### Nightly release plan\n\n${plan.latestTag} → v${plan.version} (${plan.bump}; ${plan.featureCount} feat commits, ${plan.commitCount} commits).\n`;
  } else if (plan.action === "resume") {
    summary = `### Resume release\n\nVersion ${plan.version} is already merged but not tagged; continue from ${plan.targetSha}.\n`;
  } else if (plan.action === "manual") {
    const commits = plan.breakingCommits?.map((subject) => `- ${subject}`).join("\n") ?? "";
    const reason = plan.reason === "breaking-change"
      ? "Breaking changes are not released automatically."
      : plan.reason === "release-base-advanced"
        ? "Main advanced while the release PR was merging; review and prepare a fresh release PR manually."
        : "The main package version does not match the latest release tag.";
    summary = `### Human release required\n\n${reason}\n${commits}\n`;
  } else {
    summary = `### No release needed\n\nNo commits are ahead of ${plan.latestTag}.\n`;
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

function prepareRelease(version, date) {
  const plan = calculatePlan();
  if (plan.action !== "release" || plan.version !== version) {
    throw new Error(`Release plan changed; expected ${version}, found ${plan.action} ${plan.version ?? ""}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid release date: ${date}`);

  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  if (packageJson.version !== plan.currentVersion || packageLock.version !== plan.currentVersion || packageLock.packages?.[""]?.version !== plan.currentVersion) {
    throw new Error("package.json and package-lock.json must match the latest release tag before preparing a release");
  }
  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[""].version = version;
  writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync("package-lock.json", `${JSON.stringify(packageLock, null, 2)}\n`);

  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const unreleased = /^## \[Unreleased\]\r?\n(?:\r?\n)*/m;
  if (!unreleased.test(changelog)) throw new Error("CHANGELOG.md is missing its Unreleased heading");
  if (changelog.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already contains ${version}`);
  const section = `## [${version}] - ${date}\n\n${renderReleaseNotes(plan.commits)}\n\n`;
  writeFileSync("CHANGELOG.md", changelog.replace(unreleased, `## [Unreleased]\n\n${section}`));
  console.log(`Prepared ${version} from ${plan.latestTag} using ${plan.bump} bump.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") {
    writePlan(calculatePlan());
  } else if (command === "prepare") {
    prepareRelease(args[0], args[1]);
  } else {
    console.error("Usage: node scripts/nightly-release.mjs <plan|prepare [version date]>");
    process.exitCode = 2;
  }
}