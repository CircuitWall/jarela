import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

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
const { registeredCategory, registeredCapability } = await import("@/lib/tools/runtime/registry");

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

  it("exposes opt-in inspection in the provider-facing schema without changing the tool capability", () => {
    const schema = convertToOpenAITool(readSkillTool);
    if (process.env.JARELA_PROMPT_DUMP === "1") {
      mkdirSync(join(process.cwd(), ".prompts"), { recursive: true });
      writeFileSync(join(process.cwd(), ".prompts", "tool.read-skill.json"), JSON.stringify(schema, null, 2));
    }
    expect(schema.function.parameters).toMatchObject({
      properties: { inspect_execution: { type: "boolean", description: expect.stringContaining("Never runs code or grants approval") } },
      required: ["id"],
    });
    expect(registeredCategory("read_skill")).toBe("Skills");
    expect(registeredCapability("read_skill")).toBe("read");
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
    expect(read).toEqual({ id: "expense-report", name: "expense-report", source: "user", content });
    const inspected = parse(await readSkillTool.invoke({ id: "expense-report", inspect_execution: true }));
    expect(inspected.execution).toEqual({ status: "not_declared", execution_available: false });
  });

  it("opts into inert execution inspection and keeps malformed metadata out of default reads", async () => {
    await writeSkillTool.invoke({ id: "inspect-me", content: "# Inspect Me\n\nInstructions.\n" });
    const dir = join(repo, "inspect-me");
    writeFileSync(join(dir, "entry.cjs"), 'throw new Error("Do not execute");');
    writeFileSync(join(dir, "execution.json"), JSON.stringify({
      schemaVersion: 1, entrypoint: "entry.cjs", files: ["entry.cjs"],
      inputSchema: { type: "object", properties: {} }, outputSchema: { type: "string" },
    }));
    const inspected = parse(await readSkillTool.invoke({ id: "inspect-me", inspect_execution: true }));
    expect(inspected.execution).toMatchObject({ status: "inspected", execution_available: false });
    writeFileSync(join(dir, "execution.json"), "{invalid");
    expect(parse(await readSkillTool.invoke({ id: "inspect-me" }))).not.toHaveProperty("execution");
    expect(parse(await readSkillTool.invoke({ id: "inspect-me", inspect_execution: true })).execution)
      .toMatchObject({ status: "invalid", execution_available: false });
  });

  it("does not associate a flat Markdown skill with an unrelated folder manifest", async () => {
    writeFileSync(join(repo, "flat-inspect.md"), "# Flat Inspect\n\nFlat instructions.");
    mkdirSync(join(repo, "flat-inspect"));
    writeFileSync(join(repo, "flat-inspect", "execution.json"), "{invalid");
    const read = parse(await readSkillTool.invoke({ id: "flat-inspect", inspect_execution: true }));
    expect(read.content).toContain("Flat instructions.");
    expect(read.execution).toEqual({ status: "not_declared", execution_available: false });
  });

  it("reads folded and literal block-scalar descriptions instead of the block marker", async () => {
    const folded = ["---", "name: trip-planner", "description: >-", "  Use when: planning a trip", "  from saved bookings.", "---", "", "# Trip"].join("\n");
    const literal = ["---", "description: |", "  Use when: tidying", "  the inbox.", "name: inbox", "---", "", "# Inbox"].join("\n");
    await writeSkillTool.invoke({ id: "trip-planner", content: folded });
    await writeSkillTool.invoke({ id: "inbox-tidy", content: literal });
    const listed = parse(await listSkillsTool.invoke({})) as Array<Record<string, string>>;
    expect(listed.find((s) => s.id === "trip-planner")).toMatchObject({
      name: "trip-planner",
      description: "Use when: planning a trip from saved bookings.",
    });
    expect(listed.find((s) => s.id === "inbox-tidy")).toMatchObject({
      name: "inbox",
      description: "Use when: tidying the inbox.",
    });
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

  it("inspects only the winning enabled repo, without falling back on a malformed manifest", async () => {
    const secondary = mkdtempSync(join(tmpdir(), "jarela-inspection-override-"));
    try {
      await writeSkillTool.invoke({ id: "shared-inspection", content: "# Primary\n\nFirst.\n" });
      mkdirSync(join(secondary, "shared-inspection"));
      writeFileSync(join(secondary, "shared-inspection", "SKILL.md"), "# Secondary\n\nSecond.\n");
      writeFileSync(join(secondary, "shared-inspection", "execution.json"), "{invalid");
      const row = createSkillRepo({ path: secondary });
      const read = parse(await readSkillTool.invoke({ id: "shared-inspection", inspect_execution: true }));
      expect(read.name).toBe("Secondary");
      expect(read.execution).toMatchObject({ status: "invalid" });
      getDb().prepare("UPDATE skill_repos SET enabled=0 WHERE id=?").run(row.id);
      const primary = parse(await readSkillTool.invoke({ id: "shared-inspection", inspect_execution: true }));
      expect(primary.name).toBe("Primary");
      expect(primary.execution).toEqual({ status: "not_declared", execution_available: false });
    } finally {
      rmSync(secondary, { recursive: true, force: true });
    }
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
