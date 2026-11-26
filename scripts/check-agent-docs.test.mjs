import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectAgentGuides,
  extractInlinePathCodes,
  extractMarkdownLinks,
  parseFrontmatter,
  validateDocLinks,
  validateGuide,
} from "./check-agent-docs.mjs";

const roots = [];

function fixtureRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "jarela-agent-docs-"));
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

const validGuide = `---
description: "Use when: editing widgets in widgets/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# Widget module

Read [the contract](../AGENTS.md) and \`widgets/core.ts\`.

## Review checks

- [ ] Reused \`widgets/core.ts\`.

## Testing Requirements

Run \`widgets/core.test.ts\`.
`;

describe("agent doc frontmatter", () => {
  it("accepts the loader contract from existing guides", () => {
    const parsed = parseFrontmatter(validGuide);
    expect(parsed.error).toBeUndefined();
    expect(parsed.fields.description).toBe("Use when: editing widgets in widgets/");
    expect(parsed.fields["reasoning-effort"]).toBe("high");
  });

  it("rejects guides without frontmatter", () => {
    expect(parseFrontmatter("# No metadata\n").error).toMatch(/frontmatter/);
  });
});

describe("agent doc references", () => {
  it("extracts links but not images", () => {
    const body = "[local](core.ts) ![img](shot.png) [external](https://example.com) [anchor](#top)";
    expect(extractMarkdownLinks(body)).toEqual(["core.ts", "https://example.com", "#top"]);
  });

  it("checks inline repository paths and ignores fenced examples and placeholders", () => {
    const body = [
      "Use `widgets/core.ts` and `widgets/runtime/`.",
      "Skip `~/.jarela/widgets.cjs`, `widgets/[name].ts`, and `npm run lint`.",
      "```ts",
      "import { x } from \"widgets/not-real.ts\";",
      "```",
    ].join("\n");
    expect(extractInlinePathCodes(body)).toEqual(["widgets/core.ts", "widgets/runtime/"]);
  });

  it("passes a guide whose links, paths, and testing section are real", () => {
    const repo = fixtureRepo({
      "AGENTS.md": "# Root\n",
      "widgets/Agent.md": validGuide,
      "widgets/core.ts": "export {};\n",
      "widgets/core.test.ts": "import { it } from \"vitest\";\n",
    });
    expect(validateGuide(repo, "widgets/Agent.md")).toEqual([]);
  });

  it("fails when an inline path no longer exists", () => {
    const repo = fixtureRepo({
      "AGENTS.md": "# Root\n",
      "widgets/Agent.md": validGuide,
      "widgets/core.ts": "export {};\n",
    });
    const problems = validateGuide(repo, "widgets/Agent.md");
    expect(problems).toContain("widgets/Agent.md: referenced path does not exist -> widgets/core.test.ts");
  });

  it("fails when a markdown link no longer exists", () => {
    const repo = fixtureRepo({
      "widgets/Agent.md": validGuide.replace("../AGENTS.md", "../MISSING.md"),
      "widgets/core.ts": "export {};\n",
      "widgets/core.test.ts": "import { it } from \"vitest\";\n",
    });
    const problems = validateGuide(repo, "widgets/Agent.md");
    expect(problems).toContain("widgets/Agent.md: broken markdown link -> ../MISSING.md");
  });

  it("resolves markdown links relative to the guide, not the repository root", () => {
    const repo = fixtureRepo({
      "AGENTS.md": "# Root\n",
      "widgets/Agent.md": validGuide.replace("../AGENTS.md", "AGENTS.md"),
      "widgets/core.ts": "export {};\n",
      "widgets/core.test.ts": "import { it } from \"vitest\";\n",
    });
    const problems = validateGuide(repo, "widgets/Agent.md");
    expect(problems).toContain("widgets/Agent.md: broken markdown link -> AGENTS.md");
  });

  it("checks architecture document links relative to that document", () => {
    const repo = fixtureRepo({
      "docs/GUIDE.md": "# Guide\n\nSee [decision](./ADR.md).\n",
      "docs/ADR.md": "# Decision\n",
    });
    expect(validateDocLinks(repo, "docs/GUIDE.md")).toEqual([]);
    const broken = fixtureRepo({ "docs/GUIDE.md": "# Guide\n\nSee [decision](./MISSING.md).\n" });
    expect(validateDocLinks(broken, "docs/GUIDE.md")).toContain(
      "docs/GUIDE.md: broken markdown link -> ./MISSING.md",
    );
  });

  it("fails when a guide has no Testing or Validation section", () => {
    const repo = fixtureRepo({
      "widgets/Agent.md": validGuide.replace("## Testing Requirements", "## Notes"),
      "widgets/core.ts": "export {};\n",
    });
    const problems = validateGuide(repo, "widgets/Agent.md");
    expect(problems).toContain("widgets/Agent.md: needs a Testing or Validation section");
  });

  it("fails when a guide has no Review checks section", () => {
    const repo = fixtureRepo({
      "widgets/Agent.md": validGuide.replace("## Review checks", "## Notes"),
      "widgets/core.ts": "export {};\n",
      "widgets/core.test.ts": "import { it } from \"vitest\";\n",
    });
    const problems = validateGuide(repo, "widgets/Agent.md");
    expect(problems).toContain("widgets/Agent.md: needs a Review checks section");
  });
});

describe("module guide coverage", () => {
  it("finds module guides at supported depths and ignores dependencies", () => {
    const repo = fixtureRepo({
      "components/Agent.md": "x",
      "lib/db/Agent.md": "x",
      "lib/db/node_modules/pkg/Agent.md": "x",
      "lib/db/nested/deeper/Agent.md": "x",
      "packages/tooling/Agent.md": "x",
    });
    expect(collectAgentGuides(repo)).toEqual([
      "components/Agent.md",
      "lib/db/Agent.md",
      "packages/tooling/Agent.md",
    ]);
  });
});
