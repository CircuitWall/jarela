import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-skills-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { writeSkillTool, readSkillTool, listSkillsTool } = await import("./skills");
const { getDb } = await import("@/lib/db");
const { createSkillRepo } = await import("@/lib/stores/skill-repos");

const parse = (raw: unknown) => JSON.parse(String(raw));

describe("skill tools on the agent path", () => {
  const repo = mkdtempSync(join(tmpdir(), "jarela-test-skill-repo-"));
  afterAll(() => {
    getDb().exec("DELETE FROM skill_repos");
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it("reports when no writable skill repo is configured", async () => {
    const out = parse(await writeSkillTool.invoke({ id: "no-repo", content: "# No Repo\n\nBody.\n" }));
    expect(out.error).toMatch(/No writable skill repo/);
  });

  it("lists a VS Code-style frontmatter skill with its name and description so the agent can pick it", async () => {
    createSkillRepo({ path: repo });
    const content = [
      "---",
      "name: expense-report",
      'description: "Use when: filing a monthly expense report from receipts."',
      "---",
      "",
      "# Expense Report",
      "",
      "1. Collect receipts.",
    ].join("\n");
    expect(parse(await writeSkillTool.invoke({ id: "expense-report", content }))).toEqual({ ok: true, id: "expense-report" });

    const listed = (parse(await listSkillsTool.invoke({})) as Array<Record<string, string>>)
      .find((s) => s.id === "expense-report");
    expect(listed).toMatchObject({
      name: "expense-report",
      description: "Use when: filing a monthly expense report from receipts.",
      source: "user",
    });

    const read = parse(await readSkillTool.invoke({ id: "expense-report" }));
    expect(read.content).toBe(content);
  });

  it("still describes heading-only skills from the first paragraph", async () => {
    await writeSkillTool.invoke({ id: "plain-skill", content: "# Plain Skill\n\nDoes plain things.\n\n## Steps\n" });
    const listed = (parse(await listSkillsTool.invoke({})) as Array<Record<string, string>>)
      .find((s) => s.id === "plain-skill");
    expect(listed).toMatchObject({ name: "Plain Skill", description: "Does plain things." });
  });

  it("rejects whitespace-only content instead of writing an empty skill", async () => {
    await expect(writeSkillTool.invoke({ id: "blank-skill", content: "  \n\t" })).rejects.toThrow(/content is required/);
    expect(parse(await readSkillTool.invoke({ id: "blank-skill" })).error).toMatch(/not found/);
  });

  it("rejects path-like ids on write and treats them as missing on read", async () => {
    await expect(writeSkillTool.invoke({ id: "../escape", content: "# X\n" })).rejects.toThrow();
    expect(parse(await readSkillTool.invoke({ id: "../../etc/passwd" })).error).toMatch(/not found/);
  });
});

describe("write_skill", () => {
  it("gives a clear, actionable error when content is omitted entirely", async () => {
    // @ts-expect-error — exercising the omitted-required-field case a model can hit.
    await expect(writeSkillTool.invoke({ id: "my-skill" })).rejects.toThrow(
      /content is required — pass the full markdown file body, not a patch or diff\./,
    );
  });

  it("gives the same clear error when content is an empty string", async () => {
    await expect(writeSkillTool.invoke({ id: "my-skill", content: "" })).rejects.toThrow(
      /content is required — pass the full markdown file body, not a patch or diff\./,
    );
  });
});
