import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { registeredCapability, registeredCategory } from "../runtime/registry";
import { inspectExtensionAuthoringTool, requestExtensionStageTool, startExtensionAuthoringTool } from "./extension-lifecycle";
import { cancelAuthoringOperationTool, inspectAuthoringOperationTool } from "./authoring-operations";

const tools = [startExtensionAuthoringTool, inspectExtensionAuthoringTool, requestExtensionStageTool,
  inspectAuthoringOperationTool, cancelAuthoringOperationTool];
describe("review-only authoring lifecycle tools", () => {
  it("registers proposal/cancellation as execute and inert inspection as read", () => {
    for (const tool of tools) {
      expect(registeredCategory(tool.name)).toBe("Config");
      expect(registeredCapability(tool.name)).toBe(
        [requestExtensionStageTool.name, cancelAuthoringOperationTool.name].includes(tool.name) ? "execute" : "read");
    }
  });
  it("exposes strict provider schemas without approval or identity-spoofing inputs", () => {
    for (const tool of tools) {
      const schema = convertToOpenAITool(tool);
      expect(schema.function.parameters).toMatchObject({ type: "object", additionalProperties: false });
      for (const field of ["approve", "agentId", "workspace", "publication_authorized"]) {
        expect(schema.function.parameters.properties).not.toHaveProperty(field);
      }
      if (process.env.JARELA_PROMPT_DUMP === "1") {
        mkdirSync(join(process.cwd(), ".prompts"), { recursive: true });
        writeFileSync(join(process.cwd(), ".prompts", `tool.${tool.name}.json`), JSON.stringify(schema, null, 2));
      }
    }
  });
  it("refuses authority parameters and invocation outside an agent workspace/thread", async () => {
    await expect(requestExtensionStageTool.invoke({ id: "00000000-0000-4000-8000-000000000001", stage: "test", approve: true })).rejects.toThrow();
    expect(JSON.parse(String(await startExtensionAuthoringTool.invoke({
      name: "fixture_echo", goal: "Synthetic value", discovery: { decision: "author", evidence: "No fixture" },
    })))).toHaveProperty("error");
    expect(JSON.parse(String(await inspectAuthoringOperationTool.invoke({
      id: "00000000-0000-4000-8000-000000000001", type: "extension",
    })))).toHaveProperty("error");
  });
});
