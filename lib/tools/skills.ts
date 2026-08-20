import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getSkill, writeSkill, listSkills, getSkillsDir } from "@/lib/skills";
import { registerLangChainPackage } from "./langchain-package";

const NOT_CONFIGURED = JSON.stringify({ error: "JARELA_SKILLS_DIR is not configured; built-in skills are read-only" });

export const readSkillTool = tool(
  async ({ id }) => {
    const skill = getSkill(id);
    if (!skill) return JSON.stringify({ error: `Skill "${id}" not found` });
    return JSON.stringify({ id: skill.id, name: skill.name, source: skill.source, content: skill.content });
  },
  {
    name: "read_skill",
    description:
      "Load the full content of a named skill from the skills directory. The system prompt lists available skill IDs and descriptions — use those to pick which skill to load.",
    schema: z.object({
      id: z.string().describe("Skill ID shown in the system prompt (e.g. 'code-review')"),
    }),
  },
);

export const writeSkillTool = tool(
  async ({ id, content }) => {
    if (!getSkillsDir()) return NOT_CONFIGURED;
    try {
      writeSkill(id, content);
      return JSON.stringify({ ok: true, id });
    } catch (err) {
      return JSON.stringify({ error: String(err) });
    }
  },
  {
    name: "write_skill",
    description:
      "Create or update a skill in the skills directory as a SKILL.md file, compatible with VS Code Copilot and other tools. Use this for user-requested skill edits and for proactive, scoped skill improvements that make repeated task handling more reliable.",
    schema: z.object({
      id: z
        .string()
        .regex(/^[\w-]+$/, "Letters, digits, and hyphens only")
        .describe("Skill ID used as the directory name (e.g. 'code-review')"),
      content: z
        .string()
        .min(1)
        .describe("Full markdown content of the skill, starting with a # Heading."),
    }),
  },
);

export const listSkillsTool = tool(
  async () => {
    const skills = listSkills();
    return JSON.stringify(skills.map(({ id, name, description, source }) => ({ id, name, description, source })));
  },
  {
    name: "list_skills",
    description: "List all available skills by ID, name, and description. The same list appears in the system prompt; call this only if you need a refreshed view after writing a skill.",
    schema: z.object({}),
  },
);

registerLangChainPackage({
  category: "Skills",
  tools: {
    read: [readSkillTool, listSkillsTool],
    write: [writeSkillTool],
  },
});
