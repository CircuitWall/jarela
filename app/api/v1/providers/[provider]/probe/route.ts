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
import { z } from "zod";
import { getProvider } from "@/lib/providers";
import { getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { getCredential, getCredentialParams } from "@/lib/stores/credentials";
import { validateBody } from "@/lib/api/responses";
import type { ProviderParams } from "@/lib/providers/types";

type Params = { params: Promise<{ provider: string }> };

const PROBE_TIMEOUT_MS = 15_000;

const ProbeBody = z.object({
  model_id: z.string().min(1, "model_id required"),
  params: z.record(z.string(), z.unknown()).optional(),
  name: z.string().optional(), // optional: hydrate params from saved model_config
  credential_id: z.string().optional(), // optional: hydrate api_key from saved credential
});

export async function POST(req: NextRequest, { params }: Params) {
  const { provider: providerName } = await params;
  const body = await validateBody(req, ProbeBody);
  if (body instanceof NextResponse) return body;

  // Layer params in lowest-to-highest precedence:
  //   1. saved credential (api_key / base_url / extra_headers / OAuth)
  //   2. saved model_config inline params (non-secret overrides)
  //   3. body.params (form-time overrides)
  // This lets the editor "Test connection" before save while still using
  // a stored credential's secret without surfacing it to the client.
  let providerParams: ProviderParams = {};
  if (body.credential_id) {
    const cred = getCredential(body.credential_id);
    if (cred) providerParams = { ...providerParams, ...getCredentialParams(cred) };
  }
  if (body.name) {
    const cfg = getModelConfig(body.name);
    if (cfg) providerParams = { ...providerParams, ...getModelParams(cfg) };
  }
  providerParams = { ...providerParams, ...(body.params ?? {}) };

  let provider;
  try {
    provider = getProvider(providerName);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 200 });
  }

  const probe = async () => {
    const { stream } = await provider.chat(
      body.model_id,
      [{ role: "user", content: "ping" }],
      { ...providerParams, max_tokens: 1 },
    );
    // Pull just the first chunk to confirm the stream opened.
    const iter = stream[Symbol.asyncIterator]();
    await iter.next();
    try { await (iter as { return?: () => Promise<unknown> }).return?.(); } catch { /* best-effort */ }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg });
  } finally {
    // Without this, the 15s timer keeps firing after probe() wins the
    // race and the route returns — leaking an unhandled rejection per
    // probe (which then trips the global handler).
    if (timer) clearTimeout(timer);
  }
}
