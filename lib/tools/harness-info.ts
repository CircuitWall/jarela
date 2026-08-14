import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getDefaultHarnessId, getHarness, listAllHarnesses } from "@/lib/stores/harnesses";
import { registerLangChainPackage } from "./langchain-package";

export const listHarnessesTool = tool(
  async () => {
    const defaultId = getDefaultHarnessId();
    return JSON.stringify({
      default_harness_id: defaultId,
      harnesses: listAllHarnesses().map((h) => ({
        id: h.id,
        name: h.name,
        description: h.description ?? "",
        builtin: h.builtin,
        is_default: h.id === defaultId,
        enabled_sections: Object.entries(h.sections)
          .filter(([, section]) => section.enabled)
          .map(([key]) => key),
      })),
    });
  },
  {
    name: "list_harnesses",
    description:
      "List available agent harness presets with ids, names, default status, builtin/custom source, and enabled sections. Read-only. Use before proposing harness changes.",
    schema: z.object({}),
  },
);

export const readHarnessTool = tool(
  async ({ id }) => {
    const harness = getHarness(id);
    if (!harness) return JSON.stringify({ error: `harness \"${id}\" not found` });
    return JSON.stringify({ harness, default_harness_id: getDefaultHarnessId() });
  },
  {
    name: "read_harness",
    description:
      "Read one agent harness preset, including section enabled flags and bodies. Read-only. Built-in harnesses are immutable; create a custom harness via proposal if changes are needed.",
    schema: z.object({
      id: z.string().describe("Harness id, e.g. 'builtin:default' or 'custom:<uuid>'."),
    }),
  },
);

registerLangChainPackage({
  category: "Config",
  tools: { read: [listHarnessesTool, readHarnessTool] },
});
