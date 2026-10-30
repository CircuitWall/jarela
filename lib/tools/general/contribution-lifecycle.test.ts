import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { registeredCapability, registeredCategory } from "../runtime/registry";
import {
  requestContributionTestsTool, requestContributionCommitTool, requestContributionPushTool,
  requestContributionDraftPrTool, inspectContributionOperationTool,
} from "./contribution-lifecycle";

const tools = [requestContributionTestsTool, requestContributionCommitTool, requestContributionPushTool,
  requestContributionDraftPrTool, inspectContributionOperationTool];
describe("separate contribution authority tools", () => {
  it("uses explicit Config execution, write and read capabilities", () => {
    for (const tool of tools) {
      expect(registeredCategory(tool.name)).toBe("Config");
      expect(registeredCapability(tool.name)).toBe(tool === requestContributionTestsTool ? "execute" : tool === inspectContributionOperationTool ? "read" : "write");
    }
  });
  it("exposes strict provider schemas without approval/identity authority fields", () => {
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
  it("never approves through tool inputs or operates without an owning thread", async () => {
    await expect(requestContributionCommitTool.invoke({ operation_id: "00000000-0000-4000-8000-000000000001", approve: true })).rejects.toThrow();
    expect(JSON.parse(String(await inspectContributionOperationTool.invoke({
      operation_id: "00000000-0000-4000-8000-000000000001",
    })))).toHaveProperty("error");
  });
});
