import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOptionalPackageInstalled, loadOptionalPackage } from "./optional-package";

describe("optional package resolution", () => {
  let managedDir: string;
  let originalPackagesDir: string | undefined;

  beforeEach(() => {
    originalPackagesDir = process.env.JARELA_PACKAGES_DIR;
    managedDir = mkdtempSync(join(tmpdir(), "jarela-optional-packages-"));
    process.env.JARELA_PACKAGES_DIR = managedDir;
  });

  afterEach(() => {
    if (originalPackagesDir === undefined) delete process.env.JARELA_PACKAGES_DIR;
    else process.env.JARELA_PACKAGES_DIR = originalPackagesDir;
    rmSync(managedDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("prefers a package installed in the managed packages directory", () => {
    const packageDir = join(managedDir, "node_modules", "fake-optional-package");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({
      name: "fake-optional-package",
      version: "1.0.0",
      main: "index.cjs",
    }));
    writeFileSync(join(packageDir, "index.cjs"), 'module.exports = { source: "managed" };');

    expect(loadOptionalPackage("fake-optional-package")).toEqual({ source: "managed" });
  });

  it.each([
    "@circuitwall/atlassian-langchain",
    "@circuitwall/github-langchain",
    "@circuitwall/icloud-langchain",
    "@circuitwall/jira-align-langchain",
    "@circuitwall/ms-todo-langchain",
  ])("falls back to the app workspace for %s", (packageName) => {
    delete process.env.JARELA_PACKAGES_DIR;
    expect(loadOptionalPackage(packageName)).not.toBeNull();
    expect(isOptionalPackageInstalled(packageName)).toBe(true);
  });

  it("exposes exports from the workspace fallback", () => {
    delete process.env.JARELA_PACKAGES_DIR;
    const loaded = loadOptionalPackage<{ githubFetch?: unknown }>("@circuitwall/github-langchain");

    expect(loaded).not.toBeNull();
    expect(typeof loaded?.githubFetch).toBe("function");
  });

  it("treats an absent optional package as a normal miss", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(loadOptionalPackage("@circuitwall/not-installed")).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not treat unrelated app dependencies as installed optional packages", () => {
    expect(loadOptionalPackage("@langchain/core")).toBeNull();
  });

  it("honors an explicit managed directory even when a workspace package exists", () => {
    expect(loadOptionalPackage("@circuitwall/github-langchain")).toBeNull();
    expect(isOptionalPackageInstalled("@circuitwall/github-langchain")).toBe(false);
  });
});