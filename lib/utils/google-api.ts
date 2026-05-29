import { getIntegrationRaw } from "@/lib/stores/integrations";

export function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(new Error(`timeout after ${ms}ms`)), ms).unref?.();
  return c.signal;
}

export function resolveGoogleApiKey(): string | null {
  const raw = getIntegrationRaw("google");
  const fromStore = raw?.api_key?.trim();
  if (fromStore) return fromStore;
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim() || null;
}
