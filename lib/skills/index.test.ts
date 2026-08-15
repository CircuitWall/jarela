import { describe, expect, it } from "vitest";
import { getSkill, listSkills } from "./index";

describe("built-in skills", () => {
  it("lists packaged Jarela operating skills without JARELA_SKILLS_DIR", () => {
    const skills = listSkills();
    expect(skills.map((s) => s.id)).toEqual(expect.arrayContaining([
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
});
