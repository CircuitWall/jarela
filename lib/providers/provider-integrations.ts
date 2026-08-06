// Bridges external drop-in providers that declare `credentials` into the
// integrations system so they appear in the Credentials panel and the model
// editor's credential picker like native providers.
//
// Call `refreshExternalProviderIntegrations()` at the start of any request
// to GET/PUT/DELETE /api/v1/integrations — this clears the dynamic registry
// and re-scans PROVIDERS_DIR so newly-added .cjs files are picked up without
// a restart.

import { loadExternalProvidersDetailed } from "./external";
import { BUILTIN_PROVIDER_NAMES } from "./index";
import {
  registerDynamicIntegration,
  clearDynamicIntegrations,
  type IntegrationCategory,
} from "@/lib/stores/integrations";

export function refreshExternalProviderIntegrations(): void {
  const result = loadExternalProvidersDetailed(BUILTIN_PROVIDER_NAMES);
  clearDynamicIntegrations();
  for (const [name, fields] of result.credentials) {
    if (fields.length === 0) continue;
    registerDynamicIntegration(name, {
      label: result.labels.get(name) ?? name,
      description: result.descriptions.get(name) ?? `Drop-in provider: ${name}`,
      category: "llm" as IntegrationCategory,
      fields,
    });
  }
}
