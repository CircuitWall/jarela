// Read-only introspection for LLM provider adapters. Two paired tools:
//   - list_providers: enumerate every adapter (built-in + external).
//   - describe_provider: capability map + known model context windows for one.
// Together they let the agent answer "what can we route to" or pick a model
// by capability without hand-coded knowledge of the provider catalog.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  listProviderNames,
  getProvider,
  BUILTIN_PROVIDER_NAMES,
} from "@/lib/providers";
import { listKnownModels } from "@/lib/providers/known-context-windows";
import { registerLangChainPackage } from "./langchain-package";

type ProviderSource = "builtin" | "external";

function sourceOf(name: string): ProviderSource {
  return BUILTIN_PROVIDER_NAMES.has(name) ? "builtin" : "external";
}

export const listProvidersTool = tool(
  async () => {
    const names = listProviderNames();
    const providers = names.map((name) => ({
      name,
      source: sourceOf(name),
    }));
    return JSON.stringify({
      providers,
      count: providers.length,
      builtin_count: providers.filter((p) => p.source === "builtin").length,
      external_count: providers.filter((p) => p.source === "external").length,
    });
  },
  {
    name: "list_providers",
    description:
      "List every LLM provider adapter registered in this app (built-in like " +
      "anthropic / openai / gemini / deepseek / github-copilot / langchain, plus " +
      "any external `.cjs` plugins under ~/.jarela/providers/). Read-only. " +
      "Use this before suggesting a model swap, or when answering 'what can " +
      "we route to.' Call describe_provider afterwards for capability details.",
    schema: z.object({}),
  },
);

export const describeProviderTool = tool(
  async ({ name }) => {
    let provider;
    try {
      provider = getProvider(name);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        hint: "Call list_providers to see registered names.",
      });
    }

    // Capability inferred from which methods the adapter implements. We
    // intentionally don't call listModels() here — that would hit the
    // network and require valid credentials, which makes this a "read"-class
    // tool that sometimes fails for credential reasons. Static introspection
    // only.
    const capabilities = {
      chat: typeof provider.chat === "function",
      invoke: typeof provider.invoke === "function",
      stream_invoke: typeof provider.streamInvoke === "function",
      embed: typeof provider.embed === "function",
      list_models: typeof provider.listModels === "function",
    };

    const models = listKnownModels(name);

    return JSON.stringify({
      name,
      source: sourceOf(name),
      capabilities,
      known_models: models,
      notes: [
        models.length === 0
          ? "No static model catalog for this provider — call /api/v1/models?provider=" +
            name + " for live discovery if the adapter implements list_models."
          : "Static catalog only. Live `list_models` (when supported) may include " +
            "newer models not listed here.",
      ],
    });
  },
  {
    name: "describe_provider",
    description:
      "Return capability flags (chat / invoke / stream / embed / list_models) " +
      "and the static known-models catalog (with context windows) for one " +
      "registered provider. Read-only. Use this to choose a model by capability, " +
      "or to explain provider differences to the user. Call list_providers first " +
      "if you don't know the provider name.",
    schema: z.object({
      name: z
        .string()
        .describe("Provider name from list_providers, e.g. 'anthropic', 'openai', 'gemini'"),
    }),
  },
);

registerLangChainPackage({
  category: "Config",
  tools: { read: [listProvidersTool, describeProviderTool] },
});
