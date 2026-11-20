import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarela-optional-status-"));
process.env.JARELA_PACKAGES_DIR = join(root, "packages");
mkdirSync(process.env.JARELA_PACKAGES_DIR, { recursive: true });

// One catalogue entry installed, the other missing: the ordinary user state.
const installed = join(process.env.JARELA_PACKAGES_DIR, "node_modules", "@microsoft", "copilot-sdk");
mkdirSync(installed, { recursive: true });
writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "@microsoft/copilot-sdk", version: "1.0.0", main: "index.js" }));
writeFileSync(join(installed, "index.js"), "module.exports = {};\n");

const { groupOptionalPackages, listOptionalPackageStatuses } = await import("./optional-status");
const { invalidateDependencyStatuses } = await import("./probe");

afterAll(() => {
  invalidateDependencyStatuses();
  delete process.env.JARELA_PACKAGES_DIR;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("optional package status", () => {
  it("reports live install state per package", async () => {
    const statuses = await listOptionalPackageStatuses({ force: true });
    const byId = new Map(statuses.map((status) => [status.id, status]));

    expect(byId.get("@microsoft/copilot-sdk")).toMatchObject({
      state: "satisfied",
      target: "runtime:@microsoft/copilot-sdk",
      category: "agent-runtimes",
    });
    expect(byId.get("@huggingface/transformers")).toMatchObject({
      state: "missing",
      installable: true,
      target: "runtime:@huggingface/transformers",
      category: "embeddings",
    });
  });

  it("groups by category with the pending install size", async () => {
    const groups = groupOptionalPackages(await listOptionalPackageStatuses({ force: true }));

    expect(groups.map((group) => group.id)).toEqual(["embeddings", "agent-runtimes"]);
    expect(groups[0]).toMatchObject({ label: "Embeddings and recall", pendingSizeMb: 426 });
    expect(groups[1]).toMatchObject({ pendingSizeMb: 0 });
    expect(groups[1]!.packages[0]!.withoutIt.length).toBeGreaterThan(10);
  });

  it("narrows to one category on request", async () => {
    const statuses = await listOptionalPackageStatuses({ force: true, category: "embeddings" });
    expect(statuses.map((status) => status.id)).toEqual(["@huggingface/transformers"]);
  });
});
