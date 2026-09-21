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

const { writeSkillTool } = await import("./skills");

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
