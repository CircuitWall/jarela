#!/usr/bin/env node
/*
 * Snapshot official provider pricing pages into docs/journal/pricing-snapshot.json.
 *
 * Why this exists:
 * - There is no stable, unified machine-readable pricing API across major LLM vendors.
 * - Most pricing pages are human-oriented HTML and can change structure without notice.
 *
 * What we do:
 * - Fetch known official pricing URLs.
 * - Persist metadata (status, etag, last-modified, content hash, fetched_at).
 * - Extract best-effort price-like lines (e.g. "$.../1M", "per 1M tokens") for quick review.
 *
 * This is a monitoring aid, not an accounting source of truth.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SOURCES = [
  {
    id: "openai",
    name: "OpenAI",
    pricing_url: "https://openai.com/api/pricing/",
    notes: "Official pricing page (HTML)",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    pricing_url: "https://www.anthropic.com/pricing",
    notes: "Official pricing page (HTML)",
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    pricing_url: "https://ai.google.dev/gemini-api/docs/pricing",
    notes: "Official pricing docs page (HTML)",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    pricing_url: "https://platform.deepseek.com/pricing",
    notes: "Official pricing page (HTML)",
  },
  {
    id: "cohere",
    name: "Cohere",
    pricing_url: "https://cohere.com/pricing",
    notes: "Official pricing page (HTML)",
  },
  {
    id: "moonshot",
    name: "Moonshot AI (Kimi)",
    pricing_url: "https://platform.kimi.com/docs/price/chat",
    notes: "Official Kimi API pricing (may render in Chinese)",
  },
  {
    id: "qwen",
    name: "Qwen (Alibaba / Dashscope)",
    pricing_url: "https://www.alibabacloud.com/help/en/model-studio/pricing",
    notes: "Alibaba Cloud Model Studio international pricing",
  },
];

const PRICE_LINE_RE = new RegExp(
  [
    String.raw`\$\s*\d+(?:\.\d+)?\s*(?:/|per)\s*(?:1\s*[MK]|million|thousand)?\s*(?:input|output)?\s*(?:tokens?|chars?)`,
    String.raw`(?:input|output)\s*\$\s*\d+(?:\.\d+)?\s*(?:/|per)\s*(?:1\s*[MK]|million|thousand)?\s*(?:tokens?|chars?)`,
    String.raw`\$\s*\d+(?:\.\d+)?\s*(?:/|per)\s*(?:image|minute|request)`,
  ].join("|"),
  "gi",
);

function hashContent(text) {
  return createHash("sha256").update(text).digest("hex");
}

function extractPriceSignals(html) {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const hits = plain.match(PRICE_LINE_RE) ?? [];
  const normalized = [...new Set(hits.map((s) => s.trim()))];
  return normalized.slice(0, 40);
}

async function fetchSource(source) {
  const fetched_at = new Date().toISOString();
  try {
    const res = await fetch(source.pricing_url, {
      headers: {
        "user-agent": "jarela-pricing-snapshot/1.0 (+local-script)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const body = await res.text();
    const content_hash = hashContent(body);
    const price_signals = extractPriceSignals(body);

    return {
      id: source.id,
      name: source.name,
      pricing_url: source.pricing_url,
      notes: source.notes,
      fetched_at,
      ok: res.ok,
      status: res.status,
      etag: res.headers.get("etag"),
      last_modified: res.headers.get("last-modified"),
      content_hash,
      content_length: body.length,
      price_signals,
      error: null,
    };
  } catch (error) {
    return {
      id: source.id,
      name: source.name,
      pricing_url: source.pricing_url,
      notes: source.notes,
      fetched_at,
      ok: false,
      status: null,
      etag: null,
      last_modified: null,
      content_hash: null,
      content_length: 0,
      price_signals: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const results = [];
  for (const source of SOURCES) {
    // Sequential by design: gentler on provider sites and easier to debug.
    const row = await fetchSource(source);
    results.push(row);
    const state = row.ok ? `ok:${row.status}` : `fail:${row.status ?? "network"}`;
    console.log(`[pricing] ${source.id} -> ${state} signals=${row.price_signals.length}`);
  }

  const snapshot = {
    generated_at: new Date().toISOString(),
    disclaimer:
      "No unified stable pricing API exists across providers. Verify final pricing manually on each official page.",
    sources: results,
  };

  const outPath = resolve("docs", "journal", "pricing-snapshot.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(`[pricing] wrote ${outPath}`);
}

main().catch((err) => {
  console.error("[pricing] fatal:", err);
  process.exitCode = 1;
});
