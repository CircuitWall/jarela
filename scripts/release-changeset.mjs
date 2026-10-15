// Records the release changeset: how prompts and built-in tool descriptions
// and schemas changed since the previous release. Version adoption reads it
// from docs/adoption/changesets.json in installed bundles.
//
//   npm run release:changeset                     record package.json version
//   npm run release:changeset -- --check          verify the release PR ran it
//   npm run release:changeset -- --snapshot-out <path>
//
// Backfill options: --version X --ref <git ref> --date YYYY-MM-DD
//   --previous-snapshot <path> --next-snapshot <path>
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHANGESETS_FILE = "docs/adoption/changesets.json";
const SNAPSHOT_FILE = "docs/adoption/surface-snapshot.json";
const COLLECTOR_TEST = "lib/lifecycle/surface-collect.test.ts";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const version = option("--version") ?? packageVersion;

function fail(message) {
  console.error(`release:changeset: ${message}`);
  process.exit(1);
}

if (args.includes("--check")) {
  if (!existsSync(CHANGESETS_FILE) || !existsSync(SNAPSHOT_FILE)) {
    fail(`missing ${CHANGESETS_FILE} or ${SNAPSHOT_FILE}; run \`npm run release:changeset\`.`);
  }
  const { changesets } = JSON.parse(readFileSync(CHANGESETS_FILE, "utf8"));
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"));
  if (!changesets.some((entry) => entry.version === version)) {
    fail(`no changeset for ${version}; run \`npm run release:changeset\` in the release PR.`);
  }
  if (snapshot.version !== version) {
    fail(`surface snapshot is at ${snapshot.version}, expected ${version}; run \`npm run release:changeset\`.`);
  }
  console.log(`release:changeset: ${version} changeset and surface snapshot are present.`);
  process.exit(0);
}

function runCollector(env) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", COLLECTOR_TEST],
    { stdio: "inherit", env: { ...process.env, ...env } },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const snapshotOut = option("--snapshot-out");
if (snapshotOut) {
  runCollector({ JARELA_SURFACE_OUT: snapshotOut });
  console.log(`release:changeset: wrote ${version} surface snapshot to ${snapshotOut}`);
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "jarela-changeset-"));
const reportPath = join(scratch, "report.json");
try {
  runCollector({
    JARELA_CHANGESET_WRITE: "1",
    JARELA_CHANGESET_VERSION: version,
    JARELA_CHANGESET_REPORT: reportPath,
    JARELA_CHANGESET_REF: option("--ref") ?? "",
    JARELA_CHANGESET_DATE: option("--date") ?? "",
    JARELA_CHANGESET_PREVIOUS_SNAPSHOT: option("--previous-snapshot") ?? "",
    JARELA_CHANGESET_NEXT_SNAPSHOT: option("--next-snapshot") ?? "",
  });
  if (!existsSync(reportPath)) fail("collector finished without recording a changeset.");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  console.log(
    `release:changeset: recorded ${report.version} (from ${report.previous_version}): `
      + `${report.tools} tool change(s), ${report.prompts} prompt change(s), `
      + `${report.hints} adoption hint(s), ${report.commits} commit(s).`,
  );
  console.log("Review docs/adoption/index.md and commit docs/adoption/ with the release PR.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
