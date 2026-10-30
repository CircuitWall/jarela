import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { scaffoldExtensionTool, prepareContributionBundleTool } from "./authoring";
import { registeredCapability, registeredCategory } from "../runtime/registry";

describe("authoring tool boundaries", () => {
  it("registers both deterministic text-only builders as Config/read with no write authority", () => {
    for (const tool of [scaffoldExtensionTool, prepareContributionBundleTool]) {
      expect(registeredCapability(tool.name)).toBe("read");
      expect(registeredCategory(tool.name)).toBe("Config");
      expect(tool.description).toMatch(/never|Does not/);
    }
  });
  it("returns an explicit checked scaffold and respects the reuse decision", async () => {
    const input = { name: "fixture_echo", goal: "Local fixture", discovery: { decision: "author" as const, evidence: "No fixture tool" } };
    expect(JSON.parse(String(await scaffoldExtensionTool.invoke(input)))).toMatchObject({
      ok: true, execution_authorized: false, installation_authorized: false,
    });
    expect(JSON.parse(String(await scaffoldExtensionTool.invoke({ ...input, discovery: { ...input.discovery, decision: "reuse" } }))))
      .toMatchObject({ ok: false });
  });
  it("rejects calls that attempt to add publication authority", async () => {
    await expect(prepareContributionBundleTool.invoke({ publish: true })).rejects.toThrow();
  });
  it("exposes strict bounded provider schemas without authority parameters", () => {
    for (const tool of [scaffoldExtensionTool, prepareContributionBundleTool]) {
      const schema = convertToOpenAITool(tool);
      expect(schema.function.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(schema.function.parameters.properties).not.toHaveProperty("publication_authorized");
      if (process.env.JARELA_PROMPT_DUMP === "1") {
        mkdirSync(join(process.cwd(), ".prompts"), { recursive: true });
        writeFileSync(join(process.cwd(), ".prompts", `tool.${tool.name}.json`), JSON.stringify(schema, null, 2));
      }
    }
    expect(convertToOpenAITool(prepareContributionBundleTool).function.parameters).toMatchObject({
      properties: { files: { minItems: 1, maxItems: 32, items: {
        additionalProperties: false, properties: { before: { anyOf: [{ type: "string", maxLength: 16384 }, { type: "null" }] } },
      } } },
    });
  });
});
