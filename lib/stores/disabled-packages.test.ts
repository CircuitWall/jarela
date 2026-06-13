import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-disabled-packages-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  isPackageDisabled,
  listDisabledPackages,
  setPackageDisabled,
} = await import("./disabled-packages");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("disabled-packages store", () => {
  beforeEach(() => {
    for (const id of listDisabledPackages()) setPackageDisabled(id, false);
  });

  it("missing row counts as enabled (default-on)", () => {
    expect(isPackageDisabled("github")).toBe(false);
    expect(listDisabledPackages()).toEqual([]);
  });

  it("setPackageDisabled(true) flips the flag", () => {
    setPackageDisabled("github", true);
    expect(isPackageDisabled("github")).toBe(true);
    expect(listDisabledPackages()).toContain("github");
  });

  it("setPackageDisabled(false) re-enables", () => {
    setPackageDisabled("github", true);
    setPackageDisabled("github", false);
    expect(isPackageDisabled("github")).toBe(false);
    expect(listDisabledPackages()).not.toContain("github");
  });

  it("flips are isolated per id", () => {
    setPackageDisabled("github", true);
    setPackageDisabled("atlassian", true);
    setPackageDisabled("github", false);
    expect(isPackageDisabled("github")).toBe(false);
    expect(isPackageDisabled("atlassian")).toBe(true);
    expect(listDisabledPackages().sort()).toEqual(["atlassian"]);
  });

  it("double-disable is idempotent", () => {
    setPackageDisabled("github", true);
    setPackageDisabled("github", true);
    expect(listDisabledPackages().filter((id) => id === "github").length).toBe(1);
  });
});
