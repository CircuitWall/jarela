import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SkillExecutionArtifact } from "@/lib/skills/execution-artifact";
import { cleanupAbandonedSkillStaging, SkillRunStaging } from "./skill-run-staging";

const root = vi.hoisted(() => ({ path: "" }));
vi.mock("@/lib/db/data-dir", () => ({ getDataDir: () => root.path }));
afterEach(() => {
  vi.restoreAllMocks();
  if (root.path) rmSync(root.path, { recursive: true, force: true });
});
function setup(state: "prepared" | "launched" | "cleanup_verified" = "prepared") {
  root.path = mkdtempSync(join(tmpdir(), "jarela-staging-retention-"));
  const staging = SkillRunStaging.create(SkillExecutionArtifact.capture(
    join(process.cwd(), "lib", "skills", "builtins", "memory-organization"),
  ));
  if (state !== "prepared") staging.markLaunched();
  if (state === "cleanup_verified") staging.markCleanupVerified();
  const ownerFile = join(root.path, "skill-run-owners", `${basename(staging.directory)}.json`);
  const ownership = JSON.parse(readFileSync(ownerFile, "utf8"));
  return { staging, ownerFile, ownership };
}
describe("conservative staging retention", () => {
  it("cleans a dead owner's prepared directory but never a live owner's directory", () => {
    const { staging } = setup();
    expect(cleanupAbandonedSkillStaging().retained).toHaveLength(1);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(cleanupAbandonedSkillStaging()).toEqual({ removed: [basename(staging.directory)], retained: [] });
    expect(readdirSync(join(root.path, "skill-runs"))).toEqual([]);
  });
  it("retains launched leftovers without positive cleanup evidence, even when app owner died", () => {
    const { staging } = setup("launched");
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(cleanupAbandonedSkillStaging()).toEqual({
      removed: [], retained: [{ directory: basename(staging.directory), reason: expect.stringContaining("never verified") }],
    });
  });
  it("cleans positively verified leftovers and rejects changed identity or denied process checks", () => {
    const { ownerFile, ownership } = setup("cleanup_verified");
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(cleanupAbandonedSkillStaging().removed).toEqual([]);
    writeFileSync(ownerFile, JSON.stringify({ ...ownership, inode: "different" }));
    expect(cleanupAbandonedSkillStaging().retained[0].reason).toMatch(/identity/);
    writeFileSync(ownerFile, JSON.stringify(ownership));
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(cleanupAbandonedSkillStaging().removed).toHaveLength(1);
  });
});
