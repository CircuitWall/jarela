// Validates an LLM provider API key with a single minimal request, returning
// either { ok: true, models?: string[] } or { ok: false, error, hint? }. Used
// by the first-key setup screen (ADR-0010) to fail closed with a specific
// message before persisting anything.
//
// We deliberately avoid the project's provider abstraction here — those go
// through saved model_configs, which is the chicken-and-egg we're trying to
// avoid on first launch. This route talks directly to each vendor's lightest
// public endpoint.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const Body = z.object({
  provider: z.enum(["anthropic", "openai", "gemini", "deepseek"]),
  api_key: z.string().min(1),
});

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "invalid request", hint: String(err) },
      { status: 400 },
    );
  }

  const { provider, api_key } = parsed;
  try {
    switch (provider) {
      case "anthropic":  return NextResponse.json(await testAnthropic(api_key));
      case "openai":     return NextResponse.json(await testOpenAI(api_key));
      case "gemini":     return NextResponse.json(await testGemini(api_key));
      case "deepseek":   return NextResponse.json(await testDeepseek(api_key));
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "network error", hint: String(err instanceof Error ? err.message : err) },
      { status: 200 },
    );
  }
}

async function testAnthropic(key: string) {
  if (looksLike(key, ["sk-", "sk-ant-"]) === false) {
    return { ok: false, error: "this doesn't look like an Anthropic key (expected sk-ant-…)" };
  }
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "Anthropic rejected the key (401/403). Regenerate at console.anthropic.com." };
  }
  if (res.status === 429) {
    return { ok: false, error: "Anthropic rate-limited the request. Wait and retry." };
  }
  if (!res.ok) return { ok: false, error: `Anthropic returned ${res.status}` };
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return { ok: true, models: (data.data ?? []).map((m) => m.id).sort() };
}

async function testOpenAI(key: string) {
  if (key.startsWith("sk-ant-")) {
    return { ok: false, error: "this looks like an Anthropic key, not an OpenAI key" };
  }
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) return { ok: false, error: "OpenAI rejected the key (401). Verify it at platform.openai.com/api-keys." };
  if (res.status === 429) return { ok: false, error: "OpenAI rate-limited the request. Wait and retry." };
  if (!res.ok) return { ok: false, error: `OpenAI returned ${res.status}` };
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  const chat = (data.data ?? [])
    .map((m) => m.id)
    .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id))
    .sort();
  return { ok: true, models: chat };
}

async function testGemini(key: string) {
  if (!key.startsWith("AIza")) {
    return { ok: false, error: "this doesn't look like a Google AI Studio key (expected AIza…)" };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { ok: false, error: `Google rejected the key (${res.status}). Verify at aistudio.google.com/apikey.` };
  }
  if (!res.ok) return { ok: false, error: `Google returned ${res.status}` };
  const data = (await res.json()) as { models?: Array<{ name: string }> };
  const ids = (data.models ?? [])
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((id) => id.startsWith("gemini-"))
    .sort();
  return { ok: true, models: ids };
}

async function testDeepseek(key: string) {
  const res = await fetch("https://api.deepseek.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) return { ok: false, error: "DeepSeek rejected the key (401)." };
  if (!res.ok) return { ok: false, error: `DeepSeek returned ${res.status}` };
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return { ok: true, models: (data.data ?? []).map((m) => m.id).sort() };
}

function looksLike(key: string, prefixes: string[]): boolean | null {
  if (prefixes.length === 0) return null;
  return prefixes.some((p) => key.startsWith(p));
}
