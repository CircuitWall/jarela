import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-skills-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("@/lib/db");
const { getSkill, listSkills, writeSkill, deleteSkill, getSkillsDir } = await import("./index");
const { createSkillRepo } = await import("@/lib/stores/skill-repos");

function wipe(): void {
  getDb().exec("DELETE FROM skill_repos");
}

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("built-in skills", () => {
  it("lists packaged Jarela operating skills without any skill repo configured", () => {
    const skills = listSkills();
    expect(skills.map((s) => s.id)).toEqual(expect.arrayContaining([
      "browser-navigation",
      "jarela-configuration",
      "jarela-integrations",
      "jarela-operations",
    ]));
    expect(skills.find((s) => s.id === "jarela-integrations")?.source).toBe("builtin");
  });

  it("reads packaged skill content", () => {
    const skill = getSkill("jarela-integrations");
    expect(skill?.source).toBe("builtin");
    expect(skill?.content).toContain("# Jarela Integrations");
    expect(skill?.content).toContain("describe_extension_surfaces");
  });

  it("documents agent-callable env overrides in the configuration skill", () => {
    const skill = getSkill("jarela-configuration");
    expect(skill?.source).toBe("builtin");
    expect(skill?.content).toContain("set_env_var");
    expect(skill?.content).toContain("requiresRestart");
    expect(skill?.content).toContain("restart_server");
  });

  it("ships browser navigation guidance with memory hints", () => {
    const skill = getSkill("browser-navigation");
    expect(skill?.source).toBe("builtin");
    expect(skill?.content).toContain("# Browser Navigation");
    expect(skill?.content).toContain("browser_snapshot");
    expect(skill?.content).toContain("browser_fill_many");
    expect(skill?.content).toContain("Use `memory_write`");
    expect(skill?.content).toContain("The `value` argument to `memory_write` is a string");
    expect(skill?.content).toContain("namespace: `browser.navigation`");
    expect(skill?.content).toContain("Never store secrets");
  });
});

describe("multiple skill repos", () => {
  const dirs: string[] = [];

  afterEach(() => {
    wipe();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeSkillsRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "jarela-skills-repo-"));
    dirs.push(dir);
    return dir;
  }

  function writeSkillFile(dir: string, id: string, heading: string): void {
    const skillDir = join(dir, id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# ${heading}\n\nDescription.\n`);
  }

  it("scans every enabled repo and lets a later one override an earlier one", () => {
    const primary = makeSkillsRepo();
    const secondary = makeSkillsRepo();
    writeSkillFile(primary, "shared-id", "Primary Version");
    writeSkillFile(primary, "primary-only", "Primary Only");
    writeSkillFile(secondary, "shared-id", "Secondary Version");
    writeSkillFile(secondary, "secondary-only", "Secondary Only");

    createSkillRepo({ path: primary });
    createSkillRepo({ path: secondary });

    const ids = listSkills().map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["primary-only", "secondary-only", "shared-id"]));

    const shared = getSkill("shared-id");
    expect(shared?.name).toBe("Secondary Version");
    expect(shared?.source).toBe("user");
  });

  it("skips a disabled repo when scanning", () => {
    const enabled = makeSkillsRepo();
    const disabled = makeSkillsRepo();
    writeSkillFile(enabled, "enabled-skill", "Enabled Skill");
    writeSkillFile(disabled, "disabled-skill", "Disabled Skill");

    createSkillRepo({ path: enabled });
    const disabledRow = createSkillRepo({ path: disabled });
    getDb().prepare("UPDATE skill_repos SET enabled=0 WHERE id=?").run(disabledRow.id);

    const ids = listSkills().map((s) => s.id);
    expect(ids).toContain("enabled-skill");
    expect(ids).not.toContain("disabled-skill");
  });

  it("targets writes and deletes at the writable repo only", () => {
    const primary = makeSkillsRepo();
    const secondary = makeSkillsRepo();
    createSkillRepo({ path: primary }); // first repo becomes writable by default
    createSkillRepo({ path: secondary });

    expect(getSkillsDir()).toBe(primary);

    writeSkill("new-skill", "# New Skill\n\nBody.\n");
    expect(existsSync(join(primary, "new-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(secondary, "new-skill", "SKILL.md"))).toBe(false);

    expect(deleteSkill("new-skill")).toBe(true);
    expect(existsSync(join(primary, "new-skill", "SKILL.md"))).toBe(false);
  });

  it("fails to write when no repo is configured as writable", () => {
    expect(getSkillsDir()).toBe("");
    expect(() => writeSkill("new-skill", "# New Skill\n\nBody.\n")).toThrow("No writable skill repo is configured");
  });
});
