import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractReviewChecks,
  moduleForPath,
  parseNameStatus,
  reviewChanges,
} from "./check-module-review.mjs";

const roots = [];

const GUIDE = `# Module guide

## Review checks

- [ ] A real check.

## Testing requirements

Run the tests.
`;

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "jarela-module-review-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

const GUIDES = [
  { guide: "components/Agent.md", scope: "components" },
  { guide: "app/api/Agent.md", scope: "app/api" },
  { guide: "lib/tools/Agent.md", scope: "lib/tools" },
  { guide: "lib/db/Agent.md", scope: "lib/db" },
  { guide: "scripts/Agent.md", scope: "scripts" },
  { guide: "tests/Agent.md", scope: "tests" },
];

const okCheck = () => ({ ok: true, output: "" });

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("review check extraction", () => {
  it("joins wrapped lines and keeps nested items", () => {
    const checks = extractReviewChecks(`## Review checks

- [ ] First check
  continued line
- [ ] Parent
  - [ ] Nested
## Next
`);
    expect(checks).toEqual([
      { indent: 0, text: "First check continued line" },
      { indent: 0, text: "Parent" },
      { indent: 2, text: "Nested" },
    ]);
  });

  it("returns an empty list without the section", () => {
    expect(extractReviewChecks("## Testing requirements\n\n- [ ] nope\n")).toEqual([]);
  });
});

describe("change parsing", () => {
  it("maps statuses and renames", () => {
    expect(
      parseNameStatus("M\0components/A.tsx\0R\0old.ts\0new.ts\0"),
    ).toEqual([
      { status: "M", path: "components/A.tsx" },
      { status: "D", path: "old.ts" },
      { status: "A", path: "new.ts" },
    ]);
  });

  it("maps files to the deepest guide and aliases UI helpers", () => {
    expect(moduleForPath("lib/agents/run-thread.ts")?.guide).toBe("lib/agents/Agent.md");
    expect(moduleForPath("lib/tools/runtime/registry.ts")?.guide).toBe("lib/tools/Agent.md");
    expect(moduleForPath("contexts/Theme.tsx")?.guide).toBe("components/Agent.md");
    expect(moduleForPath("lib/ui/browser-store.ts")?.guide).toBe("components/Agent.md");
    expect(moduleForPath("README.md")).toBeNull();
  });
});

describe("module checks", () => {
  it("blocks server imports and SQL in UI code", () => {
    const root = fixture({
      "components/Agent.md": GUIDE,
      "components/Bad.tsx": 'import { getDb } from "@/lib/db";\nconst x = db.prepare("select 1");\n',
    });
    const result = reviewChanges({
      repoRoot: root,
      guides: GUIDES,
      runCheck: okCheck,
      changes: [
        { status: "M", path: "components/Agent.md" },
        { status: "M", path: "components/Bad.tsx" },
      ],
    });
    expect(result.errors.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(["ui-boundary", "ui-sql"]),
    );
  });

  it("allows a clean UI change and warns when a new file misses the guide", () => {
    const root = fixture({
      "components/Agent.md": GUIDE,
      "components/Good.tsx": 'import { api } from "@/api/client";\nexport const Good = () => null;\n',
      "components/New.tsx": "export const New = () => null;\n",
    });
    const result = reviewChanges({
      repoRoot: root,
      guides: GUIDES,
      runCheck: okCheck,
      changes: [
        { status: "M", path: "components/Good.tsx" },
        { status: "A", path: "components/New.tsx" },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((finding) => finding.rule === "guide-drift")).toBe(true);
  });

  it("requires a built-ins import for a registering tool", () => {
    const root = fixture({
      "lib/tools/Agent.md": GUIDE,
      "lib/tools/runtime/builtins.ts": "",
      "lib/tools/general/new-tool.ts":
        'registerLangChainPackage({ category: "Other", tools: {} });\n',
    });
    const changes = [
      { status: "M", path: "lib/tools/Agent.md" },
      { status: "A", path: "lib/tools/general/new-tool.ts" },
    ];
    const missing = reviewChanges({ repoRoot: root, guides: GUIDES, changes });
    expect(missing.errors.map((finding) => finding.rule)).toContain("tool-unregistered");

    writeFileSync(
      join(root, "lib/tools/runtime/builtins.ts"),
      'import "../general/new-tool";\n',
    );
    writeFileSync(
      join(root, "lib/tools/general/new-tool.test.ts"),
      "import { it } from 'vitest';\n",
    );
    const registered = reviewChanges({ repoRoot: root, guides: GUIDES, changes });
    expect(registered.errors).toEqual([]);
    expect(registered.warnings.map((finding) => finding.rule)).not.toContain("tool-test");
  });

  it("blocks SQL in routes and connection pragmas outside pragmas.ts", () => {
    const root = fixture({
      "app/api/Agent.md": GUIDE,
      "app/api/v1/x/route.ts": 'const x = db.prepare("select 1");\n',
      "lib/db/Agent.md": GUIDE,
      "lib/db/extra.ts": 'db.exec("PRAGMA journal_mode = DELETE");\n',
    });
    const result = reviewChanges({
      repoRoot: root,
      guides: GUIDES,
      runCheck: okCheck,
      changes: [
        { status: "M", path: "app/api/Agent.md" },
        { status: "M", path: "app/api/v1/x/route.ts" },
        { status: "M", path: "lib/db/Agent.md" },
        { status: "M", path: "lib/db/extra.ts" },
      ],
    });
    expect(result.errors.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(["api-sql", "db-pragma"]),
    );
  });

  it("blocks shell: true in scripts and warns on hook naming", () => {
    const root = fixture({
      "scripts/Agent.md": GUIDE,
      "scripts/new-gate.mjs": 'execFileSync("git", ["status"], { shell: true });\n',
      "components/Agent.md": GUIDE,
      "components/thing.tsx": "export const Thing = () => null;\n",
    });
    const result = reviewChanges({
      repoRoot: root,
      guides: GUIDES,
      runCheck: okCheck,
      changes: [
        { status: "M", path: "scripts/Agent.md" },
        { status: "A", path: "scripts/new-gate.mjs" },
        { status: "M", path: "components/Agent.md" },
        { status: "A", path: "components/thing.tsx" },
      ],
    });
    expect(result.errors.some((finding) => finding.rule === "script-shell")).toBe(true);
    expect(result.warnings.some((finding) => finding.rule === "component-name")).toBe(true);
  });
});
