import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, test } from "vitest";
import { collectHistory, generateProjectHistory } from "./generate-project-history.mjs";

let root;
let data;
let html;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
let day = 0;
function commit(subject) {
  const date = `2026-01-${String(++day).padStart(2, "0")}T12:00:00Z`;
  git("add", ".");
  execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", subject], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "jarela-history-test-"));
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Synthetic Contributor");
  git("config", "user.email", "contributor@example.invalid");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", path.join(root, "no-hooks"));
  writeFileSync(path.join(root, "private-fixture.txt"), "one\ntwo\n");
  writeFileSync(path.join(root, "package-lock.json"), "lock one\nlock two\n");
  commit("feat(core)!: synthetic subject not for publication");
  git("tag", "v1.0.0");
  git("tag", "-a", "1.0.0", "-m", "Annotated alias");
  git("tag", "workspace-v1.0.0");
  git("tag", "backup");
  writeFileSync(path.join(root, "private-fixture.txt"), "one\n");
  commit("fix(core): remove a line");
  git("checkout", "--quiet", "-b", "side");
  writeFileSync(path.join(root, "side.txt"), "side\n");
  commit("docs(side): add side text");
  git("checkout", "--quiet", "main");
  renameSync(path.join(root, "private-fixture.txt"), path.join(root, "renamed.txt"));
  writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 0]));
  commit("refactor(core): rename a file");
  git("merge", "--quiet", "--no-ff", "side", "-m", "Synthetic merge");
  commit("Unclassified empty change");
}, 30000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("collects full reachable non-merge history, lockfiles, binary records and safe app tags", () => {
  data = collectHistory(root);
  assert.equal(data.commits.length, 5);
  assert.equal(data.merges, 1);
  assert.deepEqual(data.commits.map(c => c.type), ["feat", "fix", "docs", "refactor", "other"]);
  assert.equal(data.commits.reduce((n, c) => n + c.added, 0), 6);
  assert.equal(data.commits.reduce((n, c) => n + c.deleted, 0), 2);
  assert.equal(data.commits[0].lockAdded, 2);
  assert.equal(data.commits.find(c => c.type === "refactor").binary, 1);
  assert.equal(data.releases.length, 1);
  assert.match(data.releases[0].name, /^v?1\.0\.0$/);
  assert.deepEqual(Object.keys(data.releases[0]).sort(), ["date", "name"]);
});

test("ignores app version tags on unreachable commits", () => {
  git("checkout", "--quiet", "--orphan", "unreachable");
  writeFileSync(path.join(root, "unreachable.txt"), "unreachable\n");
  commit("feat(core): unreachable work");
  git("tag", "v99.0.0");
  git("checkout", "--quiet", "main");
  assert.equal(collectHistory(root).releases.length, 1);
});

test("generates deterministic offline HTML without editorial text or identifying metadata", () => {
  const output = generateProjectHistory(root);
  html = readFileSync(output, "utf8");
  assert.equal(readFileSync(generateProjectHistory(root), "utf8"), html);
  assert(!html.includes("__HISTORY_DATA__"));
  for (const omitted of ["renderStory", "story-title", "DATA.story", "Synthetic Contributor", "example.invalid", "synthetic subject", "private-fixture.txt", root]) {
    assert(!html.includes(omitted), `Unexpected public content: ${omitted}`);
  }
  assert(html.includes("Accumulated LOC"));
  assert(html.includes("connect-src 'none'"));
  assert(!/<script[^>]+src=/.test(html));
});

test("renders net accumulation with a retained baseline, negative type balances and export totals", async () => {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.invalid/jarela/assets/project-history.html" });
  try {
    const document = dom.window.document;
    const set = (id, value) => {
      document.getElementById(id).value = value;
      document.getElementById(id).dispatchEvent(new dom.window.Event("change"));
    };
    const lastTotal = () => document.querySelector("#rows tr:last-child").children[6].textContent;
    set("metric", "accumulated");
    for (const group of ["day", "week", "month", "version"]) {
      set("group", group);
      assert.equal(lastTotal(), "4");
    }
    const lastBar = document.querySelector('#chart g[role="graphics-symbol"]:last-of-type');
    lastBar.dispatchEvent(new dom.window.Event("focus"));
    assert(document.getElementById("tooltip").textContent.includes("Latest commit (UTC)"));
    set("group", "day");
    set("from", "2026-01-03");
    assert.equal(lastTotal(), "4");
    assert(document.getElementById("range-note").textContent.includes("Earlier baseline: 3"));
    document.getElementById("locks").click();
    assert.equal(lastTotal(), "2");
    document.querySelector('#legend button[data-type="fix"]').click();
    assert.equal(lastTotal(), "3");
    for (const rect of document.querySelectorAll("#chart rect")) {
      assert(Number.isFinite(Number(rect.getAttribute("height"))));
      assert(Number(rect.getAttribute("height")) >= 0);
    }
    let csv;
    let downloadName;
    dom.window.URL.createObjectURL = blob => { csv = blob; return "blob:synthetic"; };
    dom.window.URL.revokeObjectURL = () => {};
    dom.window.HTMLAnchorElement.prototype.click = function () { downloadName = this.download; };
    document.getElementById("csv").click();
    assert.equal(csv.type, "text/csv;charset=utf-8");
    const csvText = await new Promise((resolve, reject) => {
      const reader = new dom.window.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(csv);
    });
    const csvRows = csvText.split("\r\n").map(row => row.split(",").map(value => value.replace(/^"|"$/g, "")));
    assert.equal(csvRows[0][6], "plotted_total_accumulated");
    assert.equal(csvRows.at(-1)[6], "3");
    assert.equal(downloadName, "jarela-history-day-accumulated.csv");
    set("from", "2026-02-01");
    assert(!document.getElementById("empty").hidden);
    document.getElementById("reset").click();
    assert.equal(document.getElementById("total-lines").textContent, "8");
  } finally {
    dom.window.close();
  }
});

test("rejects shallow clones rather than generating incomplete history", () => {
  const clone = mkdtempSync(path.join(tmpdir(), "jarela-history-shallow-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--depth=1", "--no-local", pathToFileURL(root).href, clone]);
    assert.throws(() => collectHistory(clone), /full checkout.*unshallow/);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test("docs build and deployment generate and link the chart with full checkout history", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert(pkg.scripts["docs:build"].includes("npm run docs:history"));
  assert(pkg.scripts["docs:dev"].includes("npm run docs:history"));
  const workflow = readFileSync(new URL("../.github/workflows/docs-site.yml", import.meta.url), "utf8");
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /actions\/setup-node@/);
  const navigation = readFileSync(new URL("../mkdocs.yml", import.meta.url), "utf8");
  assert.match(navigation, /Project history: PROJECT_HISTORY\.md/);
  const page = readFileSync(new URL("../docs/PROJECT_HISTORY.md", import.meta.url), "utf8");
  assert.match(page, /src="assets\/project-history\.html"/);
  assert.match(page, /\]\(assets\/project-history\.html\)/);
});
