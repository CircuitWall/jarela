import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { assertSupportedNode } from "./runtime-version.mjs";

const require = createRequire(import.meta.url);
const semver = require("semver");

describe("Node runtime floor", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const workspacePackages = readdirSync(new URL("../packages/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(new URL(`../packages/${entry.name}/package.json`, import.meta.url), "utf8")));
  const workspaceBuildScript = readFileSync(new URL("../scripts/build-workspace-package.mjs", import.meta.url), "utf8");

  it.each(["22.22.2", "23.0.0", "24.0.0", "24.14.9", "25.0.0", "26.0.0-rc.1"])("rejects unsupported Node %s", (version) => {
    expect(() => assertSupportedNode(version)).toThrow("Upgrade Node");
    expect(semver.satisfies(version, pkg.engines.node)).toBe(false);
  });

  it.each(["24.15.0", "24.15.1", "24.22.0", "26.0.0", "27.0.0"])("accepts supported Node %s", (version) => {
    expect(() => assertSupportedNode(version)).not.toThrow();
    expect(semver.satisfies(version, pkg.engines.node)).toBe(true);
  });

  it("keeps package and lock engine requirements aligned and publishes the runtime check", () => {
    expect(pkg.engines.node).toBe("^24.15.0 || >=26.0.0");
    expect(lock.packages[""].engines.node).toBe(pkg.engines.node);
    expect(pkg.files).toContain("scripts/runtime-version.mjs");
  });

  it.each(workspacePackages)("$name declares the supported app runtime range", (workspacePackage) => {
    expect(workspacePackage.engines.node).toBe(pkg.engines.node);
  });

  it("builds both workspace module formats for Node 24", () => {
    expect(workspaceBuildScript.match(/target: "node24"/g) ?? []).toHaveLength(2);
  });

  it.each(["jarela-bin.mjs", "start-prod.mjs"])("%s fails before loading application code on unsupported Node", (entry) => {
    const url = new URL(entry, import.meta.url);
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `Object.defineProperty(process.versions, "node", { value: "22.22.2" }); await import(${JSON.stringify(url.href)});`,
    ], { encoding: "utf8", timeout: 15_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("found 22.22.2. Upgrade Node");
    expect(result.stderr).not.toContain("Error:");
  });
});
