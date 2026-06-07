/**
 * @public — `POST /api/v1/providers/[provider]/probe`
 *
 * Sends a 1-token "ping" chat to confirm the provider/model_id/params
 * combination actually responds. Used by the Model editor's "Test
 * connection" button and as a pre-save guard so embedding-only or
 * unauthorized models surface immediately instead of failing later
 * when an agent tries to use them.
 */

import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/providers";
import { getModelConfig, getModelParams } from "@/lib/stores/model-config";
import type { ProviderParams } from "@/lib/providers/types";

type Params = { params: Promise<{ provider: string }> };

const PROBE_TIMEOUT_MS = 15_000;

export async function POST(req: NextRequest, { params }: Params) {
  const { provider: providerName } = await params;
  const body = await req.json().catch(() => ({})) as {
    model_id?: string;
    params?: ProviderParams;
    name?: string; // optional: hydrate params from saved model_config
  };
  if (!body.model_id) {
    return NextResponse.json({ ok: false, error: "model_id required" }, { status: 400 });
  }

  // Caller can pass in-form params directly, OR reference a saved config
  // by name so the persisted (encrypted) api_key is used without surfacing
  // it back to the client.
  let providerParams: ProviderParams = body.params ?? {};
  if (body.name) {
    const cfg = getModelConfig(body.name);
    if (cfg) providerParams = { ...getModelParams(cfg), ...providerParams };
  }

  let provider;
  try {
    provider = getProvider(providerName);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 200 });
  }

  const probe = async () => {
    const { stream } = await provider.chat(
      body.model_id!,
      [{ role: "user", content: "ping" }],
      { ...providerParams, max_tokens: 1 },
    );
    // Pull just the first chunk to confirm the stream opened.
    const iter = stream[Symbol.asyncIterator]();
    await iter.next();
    try { await (iter as { return?: () => Promise<unknown> }).return?.(); } catch { /* best-effort */ }
  };

  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS)),
    ]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg });
  }
}
