import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-disabled-dropin-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { isDropinDisabled, setDropinDisabled } = await import("./disabled-dropin-tools");
const { listDisabledPackages, isPackageDisabled } = await import("./disabled-packages");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("disabled-dropin-tools store", () => {
  beforeEach(() => {
    // Clean up dropin entries between tests
    setDropinDisabled("my-tool", false);
    setDropinDisabled("other-tool", false);
  });

  it("missing row counts as enabled (default-on)", () => {
    expect(isDropinDisabled("my-tool")).toBe(false);
  });

  it("setDropinDisabled(true) disables the tool", () => {
    setDropinDisabled("my-tool", true);
    expect(isDropinDisabled("my-tool")).toBe(true);
  });

  it("setDropinDisabled(false) re-enables the tool", () => {
    setDropinDisabled("my-tool", true);
    setDropinDisabled("my-tool", false);
    expect(isDropinDisabled("my-tool")).toBe(false);
  });

  it("double-disable is idempotent", () => {
    setDropinDisabled("my-tool", true);
    setDropinDisabled("my-tool", true);
    // Only one row should exist under the dropin: prefix
    const allDisabled = listDisabledPackages().filter((id) => id === "dropin:my-tool");
    expect(allDisabled.length).toBe(1);
  });

  it("state is isolated per tool name", () => {
    setDropinDisabled("my-tool", true);
    expect(isDropinDisabled("other-tool")).toBe(false);
  });

  it("dropin entries are namespaced — do not collide with plain package ids", () => {
    setDropinDisabled("github", true);        // dropin:github
    // The plain "github" package id must be unaffected
    expect(isPackageDisabled("github")).toBe(false);
    // But the dropin:github entry should exist
    expect(listDisabledPackages()).toContain("dropin:github");
    setDropinDisabled("github", false);
  });
});
