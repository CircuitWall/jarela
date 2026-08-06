import { join } from "node:path";
import type { ModelProvider } from "./types";
import { getDataDir } from "@/lib/db/data-dir";
import {
  scanCjsPlugins,
  type PluginLoadError,
} from "@/lib/utils/cjs-plugin-loader";

export const PROVIDERS_DIR = join(getDataDir(), "providers");

// Re-exported as the legacy alias so external API types (api/types.ts)
// keep working without churn. New code should reach for `PluginLoadError`
// from `@/lib/utils/cjs-plugin-loader`.
export type ExtensionLoadError = PluginLoadError;

// A credential field declared by an external provider. Mirrors the shape of
// IntegrationField in api/types.ts so the Credentials panel can render a
// generic form for any drop-in provider that declares credentials.
export interface ExternalProviderCredentialField {
  key: string;
  label: string;
  placeholder?: string;
  secret: boolean;
  required: boolean;
}

export interface ExternalProvidersResult {
  providers: Record<string, ModelProvider>;
  files: Map<string, string>;
  // Credential fields declared per provider (empty array if none declared).
  // Used to register dynamic integration entries so the Credentials panel and
  // model-editor credential picker treat drop-in providers like native ones.
  credentials: Map<string, ExternalProviderCredentialField[]>;
  // Optional human-readable metadata per provider.
  labels: Map<string, string>;
  descriptions: Map<string, string>;
  errors: ExtensionLoadError[];
}

function isValidCredentialField(v: unknown): v is ExternalProviderCredentialField {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.key === "string" &&
    /^[a-z0-9_-]+$/i.test(o.key) &&
    typeof o.label === "string" &&
    typeof o.secret === "boolean" &&
    typeof o.required === "boolean"
  );
}

function isValid(p: unknown): p is ModelProvider {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.chat !== "function") return false;
  if (o.credentials !== undefined) {
    if (!Array.isArray(o.credentials)) return false;
    if (!o.credentials.every(isValidCredentialField)) return false;
  }
  return true;
}

export function loadExternalProvidersDetailed(
  builtins: ReadonlySet<string>,
): ExternalProvidersResult {
  const providers: Record<string, ModelProvider> = {};
  const files = new Map<string, string>();
  const credentials = new Map<string, ExternalProviderCredentialField[]>();
  const labels = new Map<string, string>();
  const descriptions = new Map<string, string>();

  const { defs, errors } = scanCjsPlugins<ModelProvider>({
    dir: PROVIDERS_DIR,
    builtins,
    validate: (mod) => (isValid(mod) ? mod : null),
    getName: (p) => p.name,
    kindLabel: "ModelProvider (need { name, chat })",
    logScope: "providers",
  });

  for (const { def, file } of defs) {
    const raw = def as unknown as Record<string, unknown>;
    providers[def.name] = def;
    files.set(def.name, file);
    credentials.set(def.name, Array.isArray(raw.credentials) ? (raw.credentials as ExternalProviderCredentialField[]) : []);
    if (typeof raw.label === "string") labels.set(def.name, raw.label);
    if (typeof raw.description === "string") descriptions.set(def.name, raw.description);
  }

  return { providers, files, credentials, labels, descriptions, errors };
}

// Convenience for callers that only need the provider map (the existing
// pattern in lib/providers/index.ts).
export function loadExternalProviders(
  builtins: ReadonlySet<string>,
): Record<string, ModelProvider> {
  return loadExternalProvidersDetailed(builtins).providers;
}

export { type ExternalProviderCredentialField as ProviderCredentialField };
