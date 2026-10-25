import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-default-packages-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.env.JARELA_PACKAGES_DIR = join(tmpRoot, "packages");

const {
  listDefaultPackages,
  findDefaultPackage,
  setDefaultPackageEnabled,
  registerDefaultPackages,
  _resetDefaultPackages,
} = await import("./default-packages");
const { registeredTools, registeredCategory, registeredCapability } = await import("../runtime/registry");

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

  it("ships the default descriptors", () => {
    const ids = listDefaultPackages().map((p) => p.id).sort();
    expect(ids).toEqual([
      "atlassian",
      "github",
      "icloud_calendar",
      "icloud_mail",
      "icloud_tasks",
      "jira_align",
    ]);
  });

  it("listDefaultPackages reports enabled=true by default for all defaults", () => {
    for (const p of listDefaultPackages()) {
      expect(p.enabled).toBe(true);
    }
  });

  it("reports integrations as uninstalled when the managed directory is empty", () => {
    expect(listDefaultPackages().every((p) => p.installed === false)).toBe(true);
  });

  it("registers workspace packages with their declared categories and capabilities", () => {
    const previousPackagesDir = process.env.JARELA_PACKAGES_DIR;
    process.env.JARELA_PACKAGES_DIR = "";
    try {
      registerDefaultPackages();

      expect(listDefaultPackages().every((p) => p.installed)).toBe(true);
      const tools = registeredTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(registeredCategory(tool.name)).toBeDefined();
        expect(["read", "write", "execute"]).toContain(registeredCapability(tool.name));
      }
      for (const name of ["icloud_mail_list_messages", "icloud_mail_delete_message"]) {
        expect(registeredCategory(name)).toBe("Mail");
      }
      for (const name of ["icloud_calendar_list_events", "icloud_calendar_delete_event"]) {
        expect(registeredCategory(name)).toBe("Calendar");
      }
      expect(registeredCapability("icloud_mail_delete_message")).toBe("write");
      expect(registeredCapability("icloud_calendar_delete_event")).toBe("write");
      expect(registeredCategory("icloud_mail_send_email")).toBe("Mail");
      expect(registeredCapability("icloud_mail_send_email")).toBe("execute");
      expect(listDefaultPackages().find((p) => p.id === "icloud_mail")?.toolCounts.execute).toBe(1);
      expect(setDefaultPackageEnabled("icloud_mail", false)).toBe(true);
      expect(registeredTools().some((tool) => tool.name === "icloud_mail_send_email")).toBe(false);
      expect(registeredCategory("icloud_calendar_list_events")).toBe("Calendar");
      expect(setDefaultPackageEnabled("icloud_mail", true)).toBe(true);
      expect(registeredCapability("icloud_mail_send_email")).toBe("execute");
    } finally {
      _resetDefaultPackages();
      if (previousPackagesDir === undefined) delete process.env.JARELA_PACKAGES_DIR;
      else process.env.JARELA_PACKAGES_DIR = previousPackagesDir;
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
      if (p.installed) expect(total).toBeGreaterThan(0);
    }
  });
});
