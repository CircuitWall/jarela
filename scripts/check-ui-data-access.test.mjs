import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentUsage, validateUiDataAccess } from "./check-ui-data-access.mjs";

const roots = [];

function fixtureRepo(files, baseline) {
  const root = mkdtempSync(join(tmpdir(), "jarela-ui-data-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }
  const baselinePath = join(root, "scripts", "ui-data-access-baseline.json");
  mkdirSync(join(baselinePath, ".."), { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("UI data-access ratchet", () => {
  it("counts fetch and localStorage usage in source files only", () => {
    const repo = fixtureRepo(
      {
        "components/a.tsx": "fetch('/x'); fetch('/y'); localStorage.setItem('k', 'v');\n",
        "components/a.test.tsx": "fetch('/ignored');\n",
      },
      { fetch: {}, localStorage: {} },
    );
    expect(currentUsage(repo)).toEqual({
      fetch: { "components/a.tsx": 2 },
      localStorage: { "components/a.tsx": 1 },
    });
  });

  it("passes at the baseline and fails above it", () => {
    const files = { "components/a.tsx": "fetch('/x');\n" };
    const baseline = { fetch: { "components/a.tsx": 1 }, localStorage: {} };
    const repo = fixtureRepo(files, baseline);
    expect(validateUiDataAccess(repo)).toEqual([]);

    writeFileSync(join(repo, "components/a.tsx"), "fetch('/x'); fetch('/y');\n");
    expect(validateUiDataAccess(repo)).toContain(
      "components/a.tsx: 2 direct fetch call(s), baseline allows 1; add a typed api/client or lib/ui/browser-store path instead",
    );
  });

  it("fails a new direct call in an unlisted file", () => {
    const repo = fixtureRepo({ "hooks/new.ts": "fetch('/x');\n" }, { fetch: {}, localStorage: {} });
    expect(validateUiDataAccess(repo)).toContain(
      "hooks/new.ts: 1 direct fetch call(s), baseline allows 0; add a typed api/client or lib/ui/browser-store path instead",
    );
  });

  it("fails a stale baseline entry", () => {
    const repo = fixtureRepo(
      { "components/a.tsx": "export const x = 1;\n" },
      { fetch: { "components/a.tsx": 1 }, localStorage: {} },
    );
    expect(validateUiDataAccess(repo)).toContain(
      "scripts/ui-data-access-baseline.json: stale fetch entry for components/a.tsx; remove or lower it",
    );
  });
});
