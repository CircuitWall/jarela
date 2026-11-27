import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatPacket,
  validateContract,
  writePackets,
} from "./check-feature-contract.mjs";

const roots = [];

const GUIDE = `# Module guide

## Review checks

- [ ] A real check.
`;

function fixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "jarela-feature-contract-"));
  roots.push(root);
  const base = {
    "lib/stores/Agent.md": GUIDE,
    "app/api/Agent.md": GUIDE,
    "docs/FEATURE_CONTRACT.md": "# Feature contracts\n",
    "lib/stores/retention.ts": "export function setRetention() {}\n",
    "lib/stores/retention.test.ts": "import { it } from 'vitest';\n",
    "app/api/v1/retention/route.ts": "export function GET() {}\n",
  };
  for (const [relative, contents] of Object.entries({ ...base, ...files })) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

function makeContract(overrides = {}) {
  return {
    schemaVersion: 1,
    feature: "retention",
    title: "Retention policy",
    adrRequired: false,
    adr: null,
    shared: ["docs/FEATURE_CONTRACT.md"],
    modules: [
      {
        id: "stores",
        guide: "lib/stores/Agent.md",
        owns: ["lib/stores/retention.ts", "lib/stores/retention.test.ts"],
        provides: [
          {
            name: "setRetention",
            file: "lib/stores/retention.ts",
            symbol: "setRetention",
          },
        ],
        consumes: [],
        validation: ["npx vitest run lib/stores/retention.test.ts"],
      },
      {
        id: "api",
        guide: "app/api/Agent.md",
        owns: ["app/api/v1/retention/route.ts"],
        provides: [],
        consumes: [{ module: "stores", name: "setRetention" }],
        validation: ["npx vitest run app/api/v1/retention/route.test.ts"],
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("feature contract validation", () => {
  it("accepts a consistent design contract", () => {
    const result = validateContract({
      repoRoot: fixture(),
      contract: makeContract(),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.modules.map((module) => module.id)).toEqual(["stores", "api"]);
  });

  it("rejects unresolved consume edges", () => {
    const contract = makeContract();
    contract.modules[1].consumes = [{ module: "stores", name: "missing" }];
    const result = validateContract({ repoRoot: fixture(), contract });
    expect(result.errors.map((finding) => finding.rule)).toContain("consume-unresolved");
  });

  it("rejects module and shared ownership overlap", () => {
    const contract = makeContract();
    contract.modules[1].owns.push("lib/stores/retention.ts");
    const overlap = validateContract({ repoRoot: fixture(), contract });
    expect(overlap.errors.map((finding) => finding.rule)).toContain("ownership-overlap");

    const shared = makeContract({
      shared: ["docs/FEATURE_CONTRACT.md", "lib/stores/retention.ts"],
    });
    const sharedOverlap = validateContract({ repoRoot: fixture(), contract: shared });
    expect(sharedOverlap.errors.map((finding) => finding.rule)).toContain("shared-overlap");
  });

  it("rejects duplicate module ids", () => {
    const contract = makeContract();
    contract.modules[1].id = "stores";
    const result = validateContract({ repoRoot: fixture(), contract });
    expect(result.errors.map((finding) => finding.rule)).toContain("module-duplicate");
  });

  it("checks provider files only when --implemented is requested", () => {
    const root = fixture();
    rmSync(join(root, "lib/stores/retention.ts"));
    const contract = makeContract();

    const design = validateContract({ repoRoot: root, contract });
    expect(design.errors).toEqual([]);

    const built = validateContract({
      repoRoot: root,
      contract,
      implemented: true,
      changes: [],
    });
    expect(built.errors.map((finding) => finding.rule)).toContain("provide-missing");
  });

  it("requires owned changes and honors contract/ignore exclusions", () => {
    const root = fixture();
    const contract = makeContract();

    const unowned = validateContract({
      repoRoot: root,
      contract,
      implemented: true,
      changes: [{ status: "M", path: "lib/utils/extra.ts" }],
    });
    expect(unowned.errors.map((finding) => finding.rule)).toContain("unowned-change");

    const excluded = validateContract({
      repoRoot: root,
      contract,
      implemented: true,
      contractFile: "docs/feature-contract.json",
      ignores: [".issue-1026.json"],
      changes: [
        { status: "A", path: "docs/feature-contract.json" },
        { status: "A", path: ".issue-1026.json" },
      ],
    });
    expect(excluded.errors).toEqual([]);
  });

  it("accepts owned changes and declared interfaces", () => {
    const result = validateContract({
      repoRoot: fixture(),
      contract: makeContract(),
      implemented: true,
      changes: [
        { status: "M", path: "lib/stores/retention.ts" },
        { status: "M", path: "docs/FEATURE_CONTRACT.md" },
      ],
    });
    expect(result.errors).toEqual([]);
  });

  it("requires a resolving ADR when declared", () => {
    const missing = validateContract({
      repoRoot: fixture(),
      contract: makeContract({ adrRequired: true }),
    });
    expect(missing.errors.map((finding) => finding.rule)).toContain("adr-missing");

    const root = fixture({ "docs/adr/0001-retention.md": "# ADR\n" });
    const resolved = validateContract({
      repoRoot: root,
      contract: makeContract({
        adrRequired: true,
        adr: "docs/adr/0001-retention.md",
      }),
    });
    expect(resolved.errors).toEqual([]);
  });
});

describe("feature packets", () => {
  it("includes ownership, interfaces, validation, and no-edit rules", () => {
    const contract = makeContract();
    const result = validateContract({ repoRoot: fixture(), contract });
    const packet = formatPacket(result.modules[0], contract, result.shared);
    expect(packet).toContain("lib/stores/Agent.md");
    expect(packet).toContain("setRetention");
    expect(packet).toContain("npx vitest run lib/stores/retention.test.ts");
    expect(packet).toContain("docs/FEATURE_CONTRACT.md");
    expect(packet).toContain("Do not edit files outside Owned files.");
  });

  it("writes one packet per module", () => {
    const root = fixture();
    const contract = makeContract();
    const result = validateContract({ repoRoot: root, contract });
    const directory = join(root, "packets");
    const written = writePackets(directory, contract, result.modules, result.shared);
    expect(written).toHaveLength(2);
    expect(readFileSync(join(directory, "stores.packet.md"), "utf8")).toContain(
      "Implementation packet: stores",
    );
    expect(readFileSync(join(directory, "api.packet.md"), "utf8")).toContain(
      "stores.setRetention",
    );
    expect(writePackets(join(directory, "empty"), contract, [])).toEqual([]);
  });
});
