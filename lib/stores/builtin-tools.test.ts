import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-builtin-tools-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  isCategoryEnabled,
  disabledCategories,
  setCategoryEnabled,
  listCategoryStates,
} = await import("./builtin-tools");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("builtin tool category toggles", () => {
  beforeEach(() => {
    // reset: re-enable everything that may have been disabled
    for (const row of listCategoryStates()) {
      if (!row.enabled) setCategoryEnabled(row.category as never, true);
    }
  });

  it("defaults unknown categories to enabled (no row = on)", () => {
    expect(isCategoryEnabled("Memory")).toBe(true);
    expect(isCategoryEnabled("Files")).toBe(true);
  });

  it("disabledCategories returns empty when nothing is off", () => {
    expect(disabledCategories().size).toBe(0);
  });

  it("setCategoryEnabled(false) flips the toggle", () => {
    setCategoryEnabled("Web", false);
    expect(isCategoryEnabled("Web")).toBe(false);
    expect(disabledCategories().has("Web")).toBe(true);
  });

  it("setCategoryEnabled(true) re-enables a previously disabled category", () => {
    setCategoryEnabled("Web", false);
    setCategoryEnabled("Web", true);
    expect(isCategoryEnabled("Web")).toBe(true);
    expect(disabledCategories().has("Web")).toBe(false);
  });

  it("toggles are isolated per category", () => {
    setCategoryEnabled("Mail", false);
    expect(isCategoryEnabled("Mail")).toBe(false);
    expect(isCategoryEnabled("Calendar")).toBe(true);
  });

  it("listCategoryStates reflects explicit rows only", () => {
    setCategoryEnabled("Shell", false);
    const rows = listCategoryStates();
    const shell = rows.find((r) => r.category === "Shell");
    expect(shell?.enabled).toBe(false);
  });
});
