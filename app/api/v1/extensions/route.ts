import {
  loadExternalProvidersDetailed,
  PROVIDERS_DIR,
} from "@/lib/providers/external";
import { BUILTIN_PROVIDER_NAMES } from "@/lib/providers";
import { loadExternalTools, getToolsDir } from "@/lib/tools/external";
import { BUILTIN_TOOL_NAMES } from "@/lib/tools";
import { describeToolSecrets } from "@/lib/stores/tool-secrets";
import { cachedJson } from "@/lib/api/responses";

export function GET() {
  const provs = loadExternalProvidersDetailed(BUILTIN_PROVIDER_NAMES);
  const tools = loadExternalTools(BUILTIN_TOOL_NAMES);

  return cachedJson({
    directories: {
      providers: PROVIDERS_DIR,
      tools: getToolsDir(),
    },
    providers: Object.values(provs.providers).map((p) => ({
      name: p.name,
      file: provs.files.get(p.name) ?? null,
    })),
    tools: tools.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      file: tools.files.get(t.name) ?? null,
      category: tools.categories.get(t.name) ?? null,
      secrets: describeToolSecrets(t.name, tools.secrets.get(t.name) ?? []),
    })),
    errors: [
      ...provs.errors.map((e) => ({ kind: "provider" as const, ...e })),
      ...tools.errors.map((e) => ({ kind: "tool" as const, ...e })),
    ],
  }, 300);
}
