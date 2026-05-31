import { getProvider } from "@/lib/providers";
import { getModelConfig, getDefaultModelConfig } from "@/lib/stores/model-config";
import type { ModelProvider, ProviderParams } from "@/lib/providers/types";

export type LlmModelRate = {
  model_id: string;
  input_per_1m_usd: number | null;
  output_per_1m_usd: number | null;
  inferred: boolean;
  confidence: "high" | "medium" | "low";
};

const SYSTEM_PROMPT = `You extract LLM API pricing from a provider's pricing page.

Output rules:
- Reply with ONLY a JSON object: {"models":[{"model_id","input_per_1m_usd","output_per_1m_usd","inferred","confidence"}]}. No prose, no markdown fences.
- model_id: lowercased canonical model identifier as the provider names it on their pricing page (e.g. "gpt-4o-mini", "claude-3-5-sonnet-20241022", "gemini-2.5-pro", "deepseek-chat"). Use the exact id you see in the table; do NOT invent versions you cannot see.
- input_per_1m_usd / output_per_1m_usd: USD price per 1,000,000 tokens. Convert from per-1K or per-1M as needed. Use null if a direction is genuinely not listed on this page for this model.
- inferred: true unless BOTH the input price AND the output price are stated explicitly and labeled (e.g. "Input $X / 1M tokens"). If you had to map an unlabeled number to a direction, set inferred=true.
- confidence: pick the LOWEST level that honestly fits — be conservative.

Confidence ladder (apply strictly):
- "high": Both input AND output are stated explicitly, labeled as such, in the same row/cell as the model id, in $/1M tokens (or trivially convertible), with NO caveats nearby ("starting at", "from", "up to", batch, cached input, prompt caching, fine-tuned, special tier, regional).
- "medium": Both directions present and mapped back to this model id, but in separate tables/sections, OR exactly one direction is labeled and the other is taken from an adjacent unlabeled rate, OR a unit conversion (per-1K -> per-1M) was required, OR a discount/caveat is mentioned ("with caching", "batch tier").
- "low": Direction was guessed (e.g. only one rate present and you assumed it was input), values came from prose rather than a pricing table, or the page mixes plan pricing (per-seat) with token pricing.

Skip rules — do NOT emit a row when:
- No \\$ value appears within the same row/section as the model id.
- The model id is a generic family ("gpt-4", "claude", "gemini") rather than a versioned model.
- The page is a marketing/plans page with no per-token table.
- Pricing is "contact sales" or unspecified.

Hard ceilings:
- At most 60 models per page.
- If the page is clearly not a per-token API pricing page, return {"models":[]}.`;

interface LlmExtractRowRaw {
  model_id?: unknown;
  input_per_1m_usd?: number | null;
  output_per_1m_usd?: number | null;
  inferred?: boolean;
  confidence?: string;
}

interface LlmExtractEnvelope {
  models?: LlmExtractRowRaw[];
}

function readEnvelope(text: string | null): LlmExtractEnvelope | null {
  if (!text) return null;
  // Tolerate leading/trailing markdown fences or stray prose by extracting the
  // first balanced JSON object. We don't run a full parser — pricing extractors
  // are run on trusted internal calls, and a malformed payload just falls back
  // to regex extraction.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as LlmExtractEnvelope;
  } catch {
    return null;
  }
}

function normalizeRate(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  // Reject obviously bogus values (a per-1M token price above $1,000 almost
  // certainly means the model misread a per-hour/per-image/per-seat number).
  if (n > 1000) return null;
  return n;
}

function normalizeRow(raw: LlmExtractRowRaw | null | undefined): LlmModelRate | null {
  if (!raw) return null;
  const modelId = typeof raw.model_id === "string" ? raw.model_id.trim().toLowerCase() : "";
  if (!modelId) return null;
  const input = normalizeRate(typeof raw.input_per_1m_usd === "number" ? raw.input_per_1m_usd : null);
  const output = normalizeRate(typeof raw.output_per_1m_usd === "number" ? raw.output_per_1m_usd : null);
  if (input == null && output == null) return null;
  const confidence: LlmModelRate["confidence"] =
    raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low"
      ? raw.confidence
      : "low";
  return {
    model_id: modelId,
    input_per_1m_usd: input,
    output_per_1m_usd: output,
    inferred: raw.inferred === false ? false : true,
    confidence,
  };
}

function pickExtractorConfig() {
  try {
    const explicit = process.env.JARELA_PRICING_EXTRACTOR_MODEL?.trim();
    if (explicit) {
      const cfg = getModelConfig(explicit);
      if (cfg) return cfg;
    }
    return getDefaultModelConfig();
  } catch {
    // model-config store opens the SQLite DB on import. In unit-test runs
    // the DB may not be initialised; treat that as "no extractor available".
    return null;
  }
}

// Trim source HTML to a single, dense plain-text view of the pricing table.
// Strips scripts/styles, collapses whitespace, and hard-caps the payload so we
// never ship a 500KB page to the LLM.
function preparePageForLlm(html: string): string {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 24_000 ? plain.slice(0, 24_000) : plain;
}

export interface LlmExtractInput {
  sourceId: string;
  sourceName: string;
  resolvedUrl: string;
  html: string;
}

export async function llmExtractModelRates(input: LlmExtractInput): Promise<LlmModelRate[] | null> {
  const cfg = pickExtractorConfig();
  if (!cfg) return null;

  let provider: ModelProvider;
  let params: ProviderParams;
  try {
    provider = getProvider(cfg.provider);
    params = JSON.parse(cfg.params) as ProviderParams;
  } catch {
    return null;
  }
  if (typeof provider.invoke !== "function") return null;

  const page = preparePageForLlm(input.html);
  if (page.length < 200) return null;

  const user = [
    `Source: ${input.sourceName} (id: ${input.sourceId})`,
    `URL: ${input.resolvedUrl}`,
    `Page text (plain, truncated to ~24K chars):`,
    "---",
    page,
    "---",
    `Return JSON only.`,
  ].join("\n");

  try {
    const result = await provider.invoke(
      cfg.model_id,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      { ...params, temperature: 0 },
      [],
    );
    const envelope = readEnvelope(result.text);
    if (!envelope || !Array.isArray(envelope.models)) return null;
    const out: LlmModelRate[] = [];
    const seen = new Set<string>();
    for (const raw of envelope.models) {
      const row = normalizeRow(raw);
      if (!row) continue;
      if (seen.has(row.model_id)) continue;
      seen.add(row.model_id);
      out.push(row);
      if (out.length >= 60) break;
    }
    return out;
  } catch {
    return null;
  }
}

export const __testing = { readEnvelope, normalizeRate, normalizeRow, preparePageForLlm };
