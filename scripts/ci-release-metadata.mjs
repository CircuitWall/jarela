import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const allowed = new Set([
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "docs/adoption/changesets.json",
  "docs/adoption/index.md",
  "docs/adoption/surface-snapshot.json",
]);

export function isReleaseMetadataOnly(changed, readJson) {
  if (!changed.length || !changed.every((file) => allowed.has(file))) return false;
  for (const file of ["package.json", "package-lock.json"]) {
    if (!changed.includes(file)) continue;
    const [before, after] = ["base", "head"].map((revision) => {
      const json = structuredClone(readJson(revision, file));
      delete json.version;
      if (file === "package-lock.json" && json.packages?.[""]) {
        delete json.packages[""].version;
      }
      return json;
    });
    if (!isDeepStrictEqual(before, after)) return false;
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const range = process.argv[2];
  if (!range || !/^[^:.\s]+\.\.[^:.\s]+$/.test(range)) {
    throw new Error("Expected an explicit base..head git range");
  }
  const [base, head] = range.split("..");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  const changed = git("diff", "--name-only", range).trim().split(/\r?\n/).filter(Boolean);
  const only = isReleaseMetadataOnly(changed, (revision, file) =>
    JSON.parse(git("show", `${revision === "base" ? base : head}:${file}`)));
  appendFileSync(process.env.GITHUB_OUTPUT, `only=${only}\n`);
  console.log(`release_meta_only=${only} changed=${changed.join(",") || "(none)"}`);
}
