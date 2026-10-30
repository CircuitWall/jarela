import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const { writeSkillTool, readSkillTool, listSkillsTool, readSkillResourceTool } = await import("./skills");
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

  it("exposes the built-in memory planner contract only through inert opt-in inspection", async () => {
    const ordinary = parse(await readSkillTool.invoke({ id: "memory-organization" }));
    expect(ordinary).toMatchObject({ id: "memory-organization", source: "builtin" });
    expect(ordinary).not.toHaveProperty("execution");
    const inspected = parse(await readSkillTool.invoke({ id: "memory-organization", inspect_execution: true }));
    expect(inspected.execution).toMatchObject({
      status: "inspected", execution_available: false,
      manifest: {
        entrypoint: "scripts/run.mjs", files: ["scripts/run.mjs", "scripts/plan-cleanup.mjs"],
        inputSchema: { properties: { entries: { items: { properties: {
          expires_at: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
        } } } } },
      },
    });
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

  it("uses one unchanged standard bundle for discovery, metadata and inert resource reads", async () => {
    const content = [
      "---", "name: shared-bundle", 'description: "Read a shared \\"example\\"."',
      "metadata:", '  name: "nested-name"', '  description: "nested-description"',
      '  version: "1.0"', "context: fork", "---", "",
      "# Shared bundle", "Read references/REFERENCE.md, assets/template.json and scripts/run.mjs.",
    ].join("\r\n");
    await writeSkillTool.invoke({ id: "shared-bundle", content });
    const dir = join(repo, "shared-bundle");
    for (const folder of ["references", "assets", "scripts"]) mkdirSync(join(dir, folder));
    const reference = "\uFEFF# Example\r\n\r\nA café reference.\r\n";
    const asset = '{"example":true}\n';
    const marker = join(dir, "script-executed");
    const script = `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "bad");`;
    writeFileSync(join(dir, "references", "REFERENCE.md"), reference);
    writeFileSync(join(dir, "assets", "template.json"), asset);
    writeFileSync(join(dir, "scripts", "run.mjs"), script);
    writeFileSync(join(dir, "execution.json"), "{invalid");
    const before = readFileSync(join(dir, "SKILL.md"));
    const listed = parse(await listSkillsTool.invoke({})) as Array<Record<string, string>>;
    expect(listed.find((entry) => entry.id === "shared-bundle")).toMatchObject({
      name: "shared-bundle", description: 'Read a shared "example".',
    });
    expect(parse(await readSkillTool.invoke({ id: "shared-bundle" })))
      .toEqual({ id: "shared-bundle", name: "shared-bundle", source: "user", content });
    const inspected = parse(await readSkillTool.invoke({ id: "shared-bundle", inspect_bundle: true, inspect_execution: true }));
    expect(inspected.bundle).toMatchObject({ status: "extended", metadata: { context: "fork" }, execution_available: false });
    expect(inspected.bundle.notices).toEqual([{ path: "context", message: expect.stringContaining("not implemented") }]);
    expect(inspected.execution.status).toBe("invalid");
    expect(process.cwd()).not.toBe(dir);
    for (const [path, content] of [["references/REFERENCE.md", reference], ["assets/template.json", asset], ["scripts/run.mjs", script]]) {
      expect(parse(await readSkillResourceTool.invoke({ id: "shared-bundle", path }))).toEqual({
        id: "shared-bundle", path, content, bytes: Buffer.byteLength(content), source: "user", execution_available: false,
      });
    }
    expect(readFileSync(join(dir, "SKILL.md"))).toEqual(before);
    expect(readFileSync(join(dir, "scripts", "run.mjs"), "utf8")).toBe(script);
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps the catalog preview short while returning full 1024-character metadata", async () => {
    const description = "x".repeat(1024);
    await writeSkillTool.invoke({ id: "long-description", content: `---\nname: long-description\ndescription: ${description}\n---\n# Long` });
    const listed = parse(await listSkillsTool.invoke({})) as Array<Record<string, string>>;
    expect(listed.find((entry) => entry.id === "long-description")?.description).toBe(description.slice(0, 200));
    expect(parse(await readSkillTool.invoke({ id: "long-description", inspect_bundle: true })).bundle)
      .toMatchObject({ status: "standard", metadata: { description } });
  });

  it.each(["café", "cafe\u0301", "代码"])("discovers, reads and writes standard Unicode skill identifier %s", async (id) => {
    const content = `---\nname: ${id}\ndescription: Unicode skill.\n---\n# Example`;
    expect(parse(await writeSkillTool.invoke({ id, content }))).toEqual({ ok: true, id });
    expect(parse(await readSkillTool.invoke({ id, inspect_bundle: true })))
      .toMatchObject({ id, name: id, content, bundle: { status: "standard" } });
    writeFileSync(join(repo, id, "reference.txt"), "reference");
    expect(parse(await readSkillResourceTool.invoke({ id, path: "reference.txt" })).content).toBe("reference");
    expect((parse(await listSkillsTool.invoke({})) as Array<{ id: string }>).some((entry) => entry.id === id)).toBe(true);
  });

  it("reports unsupported host controls and malformed metadata without dropping the original source", async () => {
    const content = "---\nname: malformed\nname: duplicate\n---\n# Original";
    await writeSkillTool.invoke({ id: "malformed", content });
    const out = parse(await readSkillTool.invoke({ id: "malformed", inspect_bundle: true }));
    expect(out.content).toBe(content);
    expect(out.bundle).toMatchObject({ status: "invalid", execution_available: false });
    expect(out.bundle.issues[0].path).toBe("frontmatter");
  });

  it("does not grant a flat skill access to an adjacent directory and rejects invalid resource paths", async () => {
    writeFileSync(join(repo, "flat-resource.md"), "# Flat");
    mkdirSync(join(repo, "flat-resource"));
    writeFileSync(join(repo, "flat-resource", "data.txt"), "not this skill's resource");
    expect(parse(await readSkillResourceTool.invoke({ id: "flat-resource", path: "data.txt" })).error)
      .toMatch(/no resource directory/);
    expect(parse(await readSkillResourceTool.invoke({ id: "missing", path: "data.txt" })).error).toMatch(/not found/);
    await expect(readSkillResourceTool.invoke({ id: "shared-bundle", path: "../outside" })).rejects.toThrow();
    const missing = parse(await readSkillResourceTool.invoke({ id: "shared-bundle", path: "missing.txt" }));
    expect(missing).toEqual({ error: "Resource read failed (ENOENT)" });
    expect(JSON.stringify(missing)).not.toContain(repo);
  });

  it("uses only the winning enabled repository for resource reads, even if a resource is missing", async () => {
    const secondary = mkdtempSync(join(tmpdir(), "jarela-resource-override-"));
    const row = createSkillRepo({ path: secondary });
    try {
      await writeSkillTool.invoke({ id: "shared-resource", content: "# Primary" });
      writeFileSync(join(repo, "shared-resource", "data.txt"), "primary");
      mkdirSync(join(secondary, "shared-resource"));
      writeFileSync(join(secondary, "shared-resource", "SKILL.md"), "# Secondary");
      const missing = parse(await readSkillResourceTool.invoke({ id: "shared-resource", path: "data.txt" }));
      expect(missing).toEqual({ error: "Resource read failed (ENOENT)" });
      writeFileSync(join(secondary, "shared-resource", "data.txt"), "secondary");
      expect(parse(await readSkillResourceTool.invoke({ id: "shared-resource", path: "data.txt" })).content).toBe("secondary");
      getDb().prepare("UPDATE skill_repos SET enabled=0 WHERE id=?").run(row.id);
      expect(parse(await readSkillResourceTool.invoke({ id: "shared-resource", path: "data.txt" })).content).toBe("primary");
    } finally {
      getDb().prepare("DELETE FROM skill_repos WHERE id=?").run(row.id);
      rmSync(secondary, { recursive: true, force: true });
    }
  });

  it("registers resource reading as a read capability with an explicit provider schema", () => {
    expect(registeredCapability("read_skill_resource")).toBe("read");
    expect(registeredCategory("read_skill_resource")).toBe("Skills");
    const schema = convertToOpenAITool(readSkillResourceTool);
    expect(schema.function.parameters).toMatchObject({
      properties: { id: { type: "string" }, path: { type: "string" } }, required: ["id", "path"],
    });
    expect(schema.function.description).toContain("Never executes code");
    expect(convertToOpenAITool(readSkillTool).function.parameters).toMatchObject({
      properties: { inspect_bundle: { type: "boolean" } }, required: ["id"],
    });
    if (process.env.JARELA_PROMPT_DUMP === "1") {
      mkdirSync(join(process.cwd(), ".prompts"), { recursive: true });
      writeFileSync(join(process.cwd(), ".prompts", "tool.read-skill-resource.json"), JSON.stringify(schema, null, 2));
    }
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
