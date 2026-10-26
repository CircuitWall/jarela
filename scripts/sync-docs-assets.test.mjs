import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test("docs builds copy the canonical per-release changelog without changing its contents", () => {
  const root = mkdtempSync(path.join(tmpdir(), "jarela-docs-sync-"));
  const script = fileURLToPath(new URL("./sync-docs-assets.mjs", import.meta.url));
  const changelog = "# Changelog\n\n## [Unreleased]\n\n## [2.7.0] - 2026-10-25\n\n- A release change.\n";
  try {
    mkdirSync(path.join(root, "public"));
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
    execFileSync(process.execPath, [script], { cwd: root });
    assert.equal(readFileSync(path.join(root, "docs", "CHANGELOG.md"), "utf8"), changelog);
    writeFileSync(path.join(root, "CHANGELOG.md"), `${changelog}\n- Another change.\n`);
    execFileSync(process.execPath, [script], { cwd: root });
    assert.equal(readFileSync(path.join(root, "docs", "CHANGELOG.md"), "utf8"), `${changelog}\n- Another change.\n`);
    const navigation = readFileSync(new URL("../mkdocs.yml", import.meta.url), "utf8");
    assert.match(navigation, /Release notes for users: CHANGELOG\.md/);
    assert.match(navigation, /Agent upgrade instructions: adoption\/index\.md/);
    writeFileSync(path.join(root, "CHANGELOG.md"),
      `${changelog}\n[ADR](./docs/adr/example.md) [Source](lib/example.ts) [Site](https://example.com) [Release](#270)\n`);
    execFileSync(process.execPath, [script], { cwd: root });
    const published = readFileSync(path.join(root, "docs", "CHANGELOG.md"), "utf8");
    assert(published.includes("[ADR](https://github.com/CircuitWall/jarela/blob/main/docs/adr/example.md)"));
    assert(published.includes("[Source](https://github.com/CircuitWall/jarela/blob/main/lib/example.ts)"));
    assert(published.includes("[Site](https://example.com) [Release](#270)"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
