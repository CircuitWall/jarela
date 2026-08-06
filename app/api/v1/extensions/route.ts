import {
  loadExternalProvidersDetailed,
  PROVIDERS_DIR,
} from "@/lib/providers/external";
import { BUILTIN_PROVIDER_NAMES } from "@/lib/providers";
import { loadExternalTools, getToolsDir } from "@/lib/tools/external";
import { getBuiltinToolNames } from "@/lib/tools";
import { describeToolSecrets } from "@/lib/stores/tool-secrets";
import { describeToolConfig } from "@/lib/stores/tool-config";
import { isDropinDisabled } from "@/lib/stores/disabled-dropin-tools";
import { noStoreJson } from "@/lib/api/responses";

export function GET() {
  const provs = loadExternalProvidersDetailed(BUILTIN_PROVIDER_NAMES);
  const tools = loadExternalTools(getBuiltinToolNames());

  return noStoreJson({
    directories: {
      providers: PROVIDERS_DIR,
      tools: getToolsDir(),
    },
    providers: Object.values(provs.providers).map((p) => ({
      name: p.name,
      file: provs.files.get(p.name) ?? null,
      label: provs.labels.get(p.name) ?? p.name,
      description: provs.descriptions.get(p.name) ?? "",
      credentials: provs.credentials.get(p.name) ?? [],
    })),
    tools: tools.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      file: tools.files.get(t.name) ?? null,
      category: tools.categories.get(t.name) ?? null,
      enabled: !isDropinDisabled(t.name),
      secrets: describeToolSecrets(t.name, tools.secrets.get(t.name) ?? []),
      config: describeToolConfig(t.name, tools.configs.get(t.name) ?? []),
    })),
    errors: [
      ...provs.errors.map((e) => ({ kind: "provider" as const, ...e })),
      ...tools.errors.map((e) => ({ kind: "tool" as const, ...e })),
    ],
  });
}
