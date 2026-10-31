import { z } from "zod";

export const ADVERTISEMENT_CONTRACT_VERSION = 2;
export function isAdvertisementMemory(namespace: string, key: string): boolean {
  return namespace === "agent-advertisements" || (namespace === "app-settings"
    && (key === "agent-advertisement-policy" || key === "agent-advertisement-usage"));
}
const text = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !/[\u0000-\u001f\u007f<>]/.test(value), "Description must be plain single-line text");
export const AdvertisementSchema = z.strictObject({
  purpose: text(160),
  call_when: z.array(text(160)).min(1).max(4),
  do_not_call_for: z.array(text(160)).min(1).max(4),
  inputs: text(200),
  output: text(200),
  tools: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,120}$/)).max(12),
}).refine((value) => JSON.stringify(value).length <= 1800, "Advertisement exceeds catalog budget");
export type Advertisement = z.infer<typeof AdvertisementSchema>;

export const AdvertisementPolicySchema = z.strictObject({
  enabled: z.boolean(),
  model_config_name: z.string().trim().min(1).max(200).nullable(),
  max_calls_per_hour: z.number().int().min(1).max(100),
  max_input_chars: z.number().int().min(1000).max(16000),
  max_output_tokens: z.number().int().min(256).max(2048),
  timeout_ms: z.number().int().min(1000).max(60000),
}).refine((value) => !value.enabled || value.model_config_name !== null, "Select a configured generation model");
export type AdvertisementPolicy = z.infer<typeof AdvertisementPolicySchema>;
export const defaultAdvertisementPolicy = (): AdvertisementPolicy => ({
  enabled: false, model_config_name: null, max_calls_per_hour: 10,
  max_input_chars: 16000, max_output_tokens: 1024, timeout_ms: 30000,
});
export const AdvertisementStateSchema = z.strictObject({
  version: z.literal(1),
  generation_id: z.string(),
  agent_id: z.string(),
  enabled: z.boolean(),
  status: z.enum(["pending", "ready", "failed", "stale", "disabled"]),
  source_fingerprint: z.string(),
  policy_fingerprint: z.string(),
  updated_at: z.string(),
  error: z.string().nullable(),
  advertisement: AdvertisementSchema.nullable(),
});
export type AdvertisementState = z.infer<typeof AdvertisementStateSchema>;
