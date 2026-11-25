import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAdrFiles, validateAdrLinks, validateAdrRegistry } from "./check-adr-registry.mjs";

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

  it("validates relative links inside ADRs and ignores prose examples", () => {
    const repo = fixtureRepo({
      "docs/adr/0001-one.md": "See [two](./0002-two.md).\n\nSyntax: [label](url).\n",
      "docs/adr/0002-two.md": "# Two\n",
    });
    expect(validateAdrLinks(repo)).toEqual([]);
  });

  it("fails a broken relative link inside an ADR", () => {
    const repo = fixtureRepo({
      "docs/adr/0001-one.md": "See [missing](./0002-two.md).\n",
    });
    expect(validateAdrLinks(repo)).toContain(
      "docs/adr/0001-one.md: broken markdown link -> ./0002-two.md",
    );
  });

  it("fails a link to a generated file that is absent from a clean checkout", () => {
    const repo = fixtureRepo({
      ".gitignore": "docs/CHANGELOG.md\n",
      "docs/CHANGELOG.md": "# Generated\n",
      "docs/adr/0001-one.md": "See [changelog](../CHANGELOG.md).\n",
    });
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    expect(validateAdrLinks(repo)).toContain(
      "docs/adr/0001-one.md: link target is generated and not checked in -> ../CHANGELOG.md",
    );
  });
});
