import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-default-packages-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  listDefaultPackages,
  findDefaultPackage,
  setDefaultPackageEnabled,
  registerDefaultPackages,
  _resetDefaultPackages,
} = await import("./default-packages");

const { setPackageDisabled, listDisabledPackages } = await import(
  "@/lib/stores/disabled-packages"
);

afterAll(() => {
  _resetDefaultPackages();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("default LangChain packages", () => {
  beforeEach(() => {
    _resetDefaultPackages();
    for (const id of listDisabledPackages()) setPackageDisabled(id, false);
  });

  it("ships three default descriptors (atlassian, github, jira_align)", () => {
    const ids = listDefaultPackages().map((p) => p.id).sort();
    expect(ids).toEqual(["atlassian", "github", "jira_align"]);
  });

  it("listDefaultPackages reports enabled=true by default for all defaults", () => {
    for (const p of listDefaultPackages()) {
      expect(p.enabled).toBe(true);
    }
  });

  it("findDefaultPackage returns the descriptor for a known id", () => {
    const d = findDefaultPackage("github");
    expect(d).not.toBeNull();
    expect(d?.label).toBe("GitHub");
    expect(d?.npmPackage).toBe("@circuitwall/github-langchain");
  });

  it("findDefaultPackage returns null for unknown id", () => {
    expect(findDefaultPackage("nope")).toBeNull();
  });

  it("registerDefaultPackages skips packages that are disabled in the store", () => {
    setPackageDisabled("github", true);
    registerDefaultPackages();
    const list = listDefaultPackages();
    expect(list.find((p) => p.id === "github")?.enabled).toBe(false);
    expect(list.find((p) => p.id === "atlassian")?.enabled).toBe(true);
  });

  it("setDefaultPackageEnabled flips the live registry", () => {
    registerDefaultPackages();
    expect(setDefaultPackageEnabled("github", false)).toBe(true);
    expect(setDefaultPackageEnabled("github", true)).toBe(true);
  });

  it("setDefaultPackageEnabled returns false for unknown ids", () => {
    expect(setDefaultPackageEnabled("nope", false)).toBe(false);
  });

  it("each descriptor exposes positive tool counts", () => {
    for (const p of listDefaultPackages()) {
      const total = p.toolCounts.read + p.toolCounts.write + p.toolCounts.execute;
      expect(total).toBeGreaterThan(0);
    }
  });
});
