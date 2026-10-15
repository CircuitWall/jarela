/**
 * Collects the live prompt + tool surface and checks it is complete and
 * deterministic. `scripts/release-changeset.mjs` also drives this file to
 * write snapshots and release changesets, because collection needs the
 * TypeScript runtime and the `@/` alias:
 *   JARELA_SURFACE_OUT=<path>   write the live snapshot to <path>
 *   JARELA_CHANGESET_WRITE=1    record the release changeset (see the script)
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-surface-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { collectSurfaceSnapshot } = await import("./surface-collect");
const { SURFACE_SNAPSHOT_SCHEMA_VERSION } = await import("./surface-snapshot");
type SurfaceSnapshot = import("./surface-snapshot").SurfaceSnapshot;

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* held open */ }
});

const root = process.cwd();
const packageVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const snapshot = await collectSurfaceSnapshot(packageVersion);

if (process.env.JARELA_SURFACE_OUT) {
  writeFileSync(process.env.JARELA_SURFACE_OUT, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

if (process.env.JARELA_CHANGESET_WRITE === "1") {
  const { writeReleaseChangeset, readSnapshot } = await import("./changeset-build");
  const readOptional = (path: string | undefined): SurfaceSnapshot | undefined =>
    path ? readSnapshot(path) : undefined;
  const entry = writeReleaseChangeset({
    root,
    version: process.env.JARELA_CHANGESET_VERSION || packageVersion,
    nextSnapshot: readOptional(process.env.JARELA_CHANGESET_NEXT_SNAPSHOT) ?? snapshot,
    previousSnapshot: readOptional(process.env.JARELA_CHANGESET_PREVIOUS_SNAPSHOT),
    date: process.env.JARELA_CHANGESET_DATE || new Date().toISOString().slice(0, 10),
    ref: process.env.JARELA_CHANGESET_REF || undefined,
  });
  if (process.env.JARELA_CHANGESET_REPORT) {
    writeFileSync(process.env.JARELA_CHANGESET_REPORT, JSON.stringify({
      version: entry.version,
      previous_version: entry.previous_version,
      prompts: entry.prompts.length,
      tools: entry.tools.length,
      hints: entry.hints.length,
      commits: entry.commits.length,
    }), "utf8");
  }
}

describe("model-facing surface snapshot", () => {
  it("covers static prompts, system prompt sections, and built-in tools", () => {
    expect(snapshot.schema_version).toBe(SURFACE_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.prompts["static.agent.tool-usage-sop"]?.text).toBeTruthy();
    expect(Object.keys(snapshot.prompts).filter((id) => id.startsWith("system."))).toEqual(
      expect.arrayContaining(["system.Tool usage SOP", "system.Self-configuration (with user approval)"]),
    );
    expect(Object.keys(snapshot.tools).length).toBeGreaterThan(50);
    expect(snapshot.tools.update_scheduled_task?.description).toBeTruthy();
  });

  it("records an object parameter schema for every tool", () => {
    for (const [name, tool] of Object.entries(snapshot.tools)) {
      expect((tool.parameters as { type?: unknown }).type, name).toBe("object");
      expect(tool.parameters, name).not.toHaveProperty("$schema");
    }
  });

  it("excludes host- and time-dependent prompt content", () => {
    expect(snapshot.prompts).not.toHaveProperty(["system.Host environment"]);
    expect(snapshot.prompts).not.toHaveProperty(["system.System signals"]);
    for (const [id, prompt] of Object.entries(snapshot.prompts)) {
      if (!id.startsWith("system.")) continue;
      expect(prompt.text, id).not.toMatch(/^Current (time|local date and time):/m);
      expect(prompt.text, id).not.toContain(tmpRoot);
    }
  });

  it("is deterministic across collections", async () => {
    expect(await collectSurfaceSnapshot(packageVersion)).toEqual(snapshot);
  });
});
