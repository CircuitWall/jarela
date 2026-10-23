import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAdoptionHints,
  renderChangesetsMarkdown,
  upsertChangeset,
  writeReleaseChangeset,
} from "./changeset-build";
import type { SurfaceSnapshot } from "./surface-snapshot";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-changeset-build-"));
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* held open */ }
});

const CHANGELOG = [
  "# Changelog",
  "## [Unreleased]",
  "## [2.3.0] - 2026-02-01",
  "### Added",
  "- Something.",
  "### Adoption",
  "- Re-run watchers that use `web_search`;",
  "  the `query` param is now required.",
  "- Remove `old_tool` from allowlists.",
  "## [2.2.0] - 2026-01-01",
  "### Adoption",
  "- Older hint.",
].join("\n");

function snapshot(version: string, tools: SurfaceSnapshot["tools"], prompts: SurfaceSnapshot["prompts"] = {}): SurfaceSnapshot {
  return { schema_version: 1, version, prompts, tools };
}

describe("extractAdoptionHints", () => {
  it("reads only the version's Adoption bullets, joining wrapped lines", () => {
    expect(extractAdoptionHints(CHANGELOG, "2.3.0")).toEqual([
      "Re-run watchers that use `web_search`; the `query` param is now required.",
      "Remove `old_tool` from allowlists.",
    ]);
    expect(extractAdoptionHints(CHANGELOG, "2.2.0")).toEqual(["Older hint."]);
    expect(extractAdoptionHints(CHANGELOG, "9.9.9")).toEqual([]);
  });
});

describe("upsertChangeset and renderChangesetsMarkdown", () => {
  const base = { previous_version: "1.0.0", date: "d", hints: [], commits: [], prompts: [], tools: [] };

  it("replaces an existing version and keeps versions sorted", () => {
    const file = upsertChangeset(
      { schema_version: 1, changesets: [{ ...base, version: "2.10.0" }, { ...base, version: "2.9.0", hints: ["old"] }] },
      { ...base, version: "2.9.0", hints: ["new"] },
    );
    expect(file.changesets.map((e) => [e.version, e.hints])).toEqual([["2.9.0", ["new"]], ["2.10.0", []]]);
    const md = renderChangesetsMarkdown(file);
    expect(md.indexOf("## 2.10.0")).toBeLessThan(md.indexOf("## 2.9.0"));
    expect(md).toContain("- new");
  });
});

describe("writeReleaseChangeset", () => {
  it("diffs the committed snapshot, writes docs, and advances the snapshot", () => {
    const root = join(tmpRoot, "repo");
    mkdirSync(join(root, "docs/adoption"), { recursive: true });
    writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG);
    const prev = snapshot("2.2.0", { web_search: { description: "Search.", parameters: { type: "object", properties: { query: {} } } } });
    writeFileSync(join(root, "docs/adoption/surface-snapshot.json"), JSON.stringify(prev));
    const next = snapshot("ignored", {
      web_search: { description: "Search.", parameters: { type: "object", properties: { query: {} }, required: ["query"] } },
    }, { "system.Rules": { source: "s.ts", text: "be careful" } });

    const gitEnv = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"] as const;
    const savedGitEnv = new Map(gitEnv.map((key) => [key, process.env[key]]));
    for (const key of gitEnv) delete process.env[key];
    let entry: ReturnType<typeof writeReleaseChangeset>;
    try {
      entry = writeReleaseChangeset({ root, version: "2.3.0", nextSnapshot: next, date: "2026-02-01" });
    } finally {
      for (const key of gitEnv) {
        const value = savedGitEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(entry).toMatchObject({ version: "2.3.0", previous_version: "2.2.0", commits: [] });
    expect(entry.hints).toHaveLength(2);
    expect(entry.tools).toMatchObject([{ name: "web_search", required_added: ["query"] }]);
    expect(entry.prompts).toMatchObject([{ id: "system.Rules", change: "added" }]);
    const written = JSON.parse(readFileSync(join(root, "docs/adoption/changesets.json"), "utf8"));
    expect(written.changesets.map((e: { version: string }) => e.version)).toEqual(["2.3.0"]);
    expect(JSON.parse(readFileSync(join(root, "docs/adoption/surface-snapshot.json"), "utf8")).version).toBe("2.3.0");
    expect(readFileSync(join(root, "docs/adoption/index.md"), "utf8")).toContain("`web_search` — changed");
  });

  it("refuses to record a version that is not newer than the snapshot", () => {
    const root = join(tmpRoot, "stale");
    mkdirSync(join(root, "docs/adoption"), { recursive: true });
    writeFileSync(join(root, "docs/adoption/surface-snapshot.json"), JSON.stringify(snapshot("2.3.0", {})));
    expect(() => writeReleaseChangeset({ root, version: "2.2.0", nextSnapshot: snapshot("x", {}), date: "d" }))
      .toThrow(/must be newer/);
  });
});
