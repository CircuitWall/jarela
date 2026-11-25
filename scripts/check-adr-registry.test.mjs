import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAdrFiles, validateAdrRegistry } from "./check-adr-registry.mjs";

const roots = [];

function fixtureRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "jarela-adr-registry-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("ADR registry", () => {
  it("collects only numbered ADR files", () => {
    const repo = fixtureRepo({
      "docs/adr/0001-one.md": "# One\n",
      "docs/adr/README.md": "# Index\n",
      "docs/adr/notes.txt": "x",
    });
    expect(collectAdrFiles(repo)).toEqual([
      { name: "0001-one.md", number: "0001", file: "docs/adr/0001-one.md" },
    ]);
  });

  it("passes unique identifiers and resolvable references", () => {
    const repo = fixtureRepo({
      "docs/adr/0001-one.md": "# One\n",
      "docs/adr/0002-two.md": "See ADR-0001.\n",
      "docs/ARCHITECTURE.md": "See ADR-0002.\n",
    });
    expect(validateAdrRegistry(repo)).toEqual([]);
  });

  it("fails duplicate identifiers", () => {
    const repo = fixtureRepo({
      "docs/adr/0001-one.md": "# One\n",
      "docs/adr/0001-two.md": "# Two\n",
    });
    expect(validateAdrRegistry(repo)).toContain(
      "ADR-0001 is duplicated by docs/adr/0001-one.md and docs/adr/0001-two.md",
    );
  });

  it("fails references to a missing ADR", () => {
    const repo = fixtureRepo({
      "docs/adr/0001-one.md": "# One\n",
      "docs/GUIDE.md": "See ADR-9999.\n",
    });
    expect(validateAdrRegistry(repo)).toContain(
      "docs/GUIDE.md: references ADR-9999, but no docs/adr/9999-*.md exists",
    );
  });

  it("ignores the historical CHANGELOG", () => {
    const repo = fixtureRepo({
      "docs/adr/0001-one.md": "# One\n",
      "docs/CHANGELOG.md": "See ADR-9999.\n",
    });
    expect(validateAdrRegistry(repo)).toEqual([]);
  });
});
