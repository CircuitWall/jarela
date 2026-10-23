import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync }));

const { notifyIfBehind, runUpdate } = await import("./update.mjs");

const roots = [];
function makeRoot(version, { source = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jarela-update-test-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@circuitwall/jarela", version }));
  if (source) mkdirSync(join(root, ".git"));
  return root;
}

function registryReturns(version) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ version }) })));
}

const logs = { out: [], err: [] };
const printed = () => [...logs.out, ...logs.err].join("\n");
const commands = () => spawnSync.mock.calls.map(([cmd, args]) => [cmd, ...args].join(" "));

beforeEach(() => {
  delete process.env.JARELA_UPDATE_CHANNEL;
  spawnSync.mockReset();
  spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  logs.out = [];
  logs.err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { logs.err.push(a.join(" ")); });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.JARELA_UPDATE_CHANNEL;
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

describe("runUpdate (stable channel)", () => {
  it("installs the latest package when the registry is ahead", async () => {
    registryReturns("2.1.0");
    expect(await runUpdate({ root: makeRoot("2.0.5") })).toBe(0);
    expect(commands()).toEqual(["npm i -g @circuitwall/jarela@latest"]);
    expect(printed()).toContain("2.0.5 -> 2.1.0");
  });

  it("does nothing when already current", async () => {
    registryReturns("2.0.5");
    expect(await runUpdate({ root: makeRoot("2.0.5") })).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(printed()).toContain("already up to date");
  });

  it("upgrades a prerelease build to its stable release", async () => {
    registryReturns("2.1.0");
    expect(await runUpdate({ root: makeRoot("2.1.0-beta.2") })).toBe(0);
    expect(commands()).toEqual(["npm i -g @circuitwall/jarela@latest"]);
  });

  it("compares hyphenated prerelease identifiers in full", async () => {
    registryReturns("2.1.0-beta-2");
    expect(await runUpdate({ root: makeRoot("2.1.0-beta-1") })).toBe(0);
    expect(commands()).toEqual(["npm i -g @circuitwall/jarela@latest"]);
  });

  it("ignores build metadata when comparing versions", async () => {
    registryReturns("2.0.5+build.9");
    expect(await runUpdate({ root: makeRoot("2.0.5+build.1") })).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("still attempts the install when the registry is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await runUpdate({ root: makeRoot("2.0.5") })).toBe(0);
    expect(printed()).toContain("could not reach the registry");
    expect(commands()).toEqual(["npm i -g @circuitwall/jarela@latest"]);
  });

  it("refuses to npm-install over a source checkout", async () => {
    registryReturns("9.9.9");
    expect(await runUpdate({ root: makeRoot("2.0.5", { source: true }) })).toBe(1);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(printed()).toContain("git pull && npm i && npm run build");
  });

  it("surfaces npm's exit status and an elevated-retry hint on failure", async () => {
    registryReturns("2.1.0");
    spawnSync.mockReturnValue({ status: 243 });
    expect(await runUpdate({ root: makeRoot("2.0.5") })).toBe(243);
    expect(printed()).toContain("npm exited 243");
    expect(printed()).toMatch(/npm i -g @circuitwall\/jarela@latest/);
  });

  it("explains a launch failure instead of reporting 'exited null'", async () => {
    registryReturns("2.1.0");
    spawnSync.mockReturnValue({ status: null, error: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }) });
    expect(await runUpdate({ root: makeRoot("2.0.5") })).toBe(1);
    expect(printed()).not.toContain("exited null");
    expect(printed()).toContain("could not run npm");
    expect(printed()).toContain("ENOENT");
  });
});

describe("runUpdate (main channel)", () => {
  beforeEach(() => { process.env.JARELA_UPDATE_CHANNEL = "main"; });

  it("pulls, installs, and rebuilds a source checkout in order", async () => {
    expect(await runUpdate({ root: makeRoot("2.0.5", { source: true }) })).toBe(0);
    expect(commands()).toEqual(["git pull --ff-only origin main", "npm install", "npm run build"]);
  });

  it("stops before installing when git pull fails", async () => {
    spawnSync.mockReturnValueOnce({ status: 128 });
    expect(await runUpdate({ root: makeRoot("2.0.5", { source: true }) })).toBe(128);
    expect(commands()).toEqual(["git pull --ff-only origin main"]);
    expect(printed()).toContain("git pull failed");
  });

  it("tells the user the tree is pulled but not rebuilt when a later step fails", async () => {
    spawnSync
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 2 });
    expect(await runUpdate({ root: makeRoot("2.0.5", { source: true }) })).toBe(2);
    expect(commands()).toEqual(["git pull --ff-only origin main", "npm install", "npm run build"]);
    expect(printed()).toContain("npm run build failed");
    expect(printed()).toContain("npm i && npm run build");
  });

  it("installs from GitHub main for an installed copy", async () => {
    expect(await runUpdate({ root: makeRoot("2.0.5") })).toBe(0);
    expect(commands()).toEqual(["npm i -g github:CircuitWall/jarela#main"]);
  });
});

describe("notifyIfBehind", () => {
  it("prints an upgrade banner when the registry is ahead", async () => {
    registryReturns("2.1.0");
    await notifyIfBehind({ root: makeRoot("2.0.5") });
    expect(printed()).toContain("update available: 2.0.5 -> 2.1.0");
  });

  it("stays silent when current, offline, or the registry errors", async () => {
    registryReturns("2.0.5");
    await notifyIfBehind({ root: makeRoot("2.0.5") });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await notifyIfBehind({ root: makeRoot("2.0.5") });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await notifyIfBehind({ root: makeRoot("2.0.5") });
    expect(printed()).toBe("");
  });

  it("flags a prerelease build once its stable release ships", async () => {
    registryReturns("2.1.0");
    await notifyIfBehind({ root: makeRoot("2.1.0-beta.2") });
    expect(printed()).toContain("update available");
  });
});
