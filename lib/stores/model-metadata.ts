import { z } from "zod";
import { getDb } from "@/lib/db";
import { withDbTransaction } from "@/lib/db/transaction";
import { modelCapabilities } from "@/lib/providers/capabilities";

export const capabilityKeySchema = z.enum([
  "vision", "tools", "streaming", "json_mode", "web_search", "audio", "files",
]);
const provenance = {
  evidence: z.string().trim().min(1).max(1200),
  source_url: z.url(),
  checked_at: z.iso.datetime(),
};
export const modelMetadataSchema = z.object({
  provider: z.string().min(1),
  model_id: z.string().min(1),
  version: z.object({ value: z.string().min(1), ...provenance }).optional(),
  capabilities: z.partialRecord(capabilityKeySchema, z.object({ value: z.boolean(), ...provenance })),
});
export type ModelMetadata = z.infer<typeof modelMetadataSchema>;
export const providerFeatureSchema = z.object({
  provider: z.string().min(1),
  feature: z.enum(["web_search", "web_fetch"]),
  ...provenance,
});
export type ProviderFeature = z.infer<typeof providerFeatureSchema>;

const NAMESPACE = "model-metadata";

export function canonicalMetadataProvider(provider: string): string {
  const canonical = provider.trim().toLowerCase();
  return canonical === "google-gemini" || canonical === "google" ? "gemini" : canonical;
}

export function listModelMetadata(provider?: string): ModelMetadata[] {
  const rows = getDb().prepare("SELECT value FROM memory_store WHERE namespace=?").all(NAMESPACE) as Array<{ value: string }>;
  return rows.map((row) => modelMetadataSchema.parse(JSON.parse(row.value)))
    .filter((row) => !provider || row.provider === canonicalMetadataProvider(provider));
}

export function saveModelMetadata(observations: ModelMetadata[]): void {
  withDbTransaction(() => {
    const previous = new Map(listModelMetadata().map((row) => [`${row.provider}:${row.model_id}`, row]));
    const now = new Date().toISOString();
    const statement = getDb().prepare(
      "INSERT INTO memory_store (namespace,key,value,created_at,updated_at) VALUES (?,?,?,?,?) " +
      "ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    );
    for (const observation of observations) {
      const row = modelMetadataSchema.parse({
        ...observation, provider: canonicalMetadataProvider(observation.provider), model_id: observation.model_id.trim().toLowerCase(),
      });
      const key = `${row.provider}:${row.model_id}`;
      const old = previous.get(key);
      const merged = { ...old, ...row, version: row.version ?? old?.version, capabilities: { ...old?.capabilities, ...row.capabilities } };
      statement.run(NAMESPACE, key, JSON.stringify(merged), now, now);
      previous.set(key, merged);
    }
  });
}

export function resolvedModelMetadata(provider: string, modelId: string, rows = listModelMetadata(provider)) {
  const metadata = rows.find((row) => row.provider === canonicalMetadataProvider(provider) && row.model_id === modelId.toLowerCase());
  const capabilities = modelCapabilities(canonicalMetadataProvider(provider), modelId);
  for (const key of capabilityKeySchema.options) {
    const observation = metadata?.capabilities[key];
    if (observation) capabilities[key] = observation.value;
  }
  return { capabilities, model_metadata: metadata };
}

export function listProviderFeatures(): ProviderFeature[] {
  const rows = getDb().prepare("SELECT value FROM memory_store WHERE namespace=?").all("provider-api-features") as Array<{ value: string }>;
  return rows.map((row) => providerFeatureSchema.parse(JSON.parse(row.value)));
}

export function saveProviderFeatures(features: ProviderFeature[]): void {
  withDbTransaction(() => {
    const statement = getDb().prepare(
      "INSERT INTO memory_store (namespace,key,value,created_at,updated_at) VALUES (?,?,?,?,?) " +
      "ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    );
    const now = new Date().toISOString();
    for (const feature of features) {
      const row = providerFeatureSchema.parse(feature);
      statement.run("provider-api-features", `${row.provider}:${row.feature}`, JSON.stringify(row), now, now);
    }
  });
}
