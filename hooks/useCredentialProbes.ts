"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { Credential } from "@/api/types";

// Cached probe outcome per credential. The Credentials list mounts this
// hook once and fires a probe for every saved row in parallel — but we
// don't want every panel re-mount or React re-render to hammer the
// upstream APIs again, so the result lives in a module-level Map until
// a credentials-changed event invalidates it.
export type CredentialProbeState = "idle" | "running" | "ok" | "error" | "unsupported";

export interface CredentialProbeResult {
  state: CredentialProbeState;
  message?: string;
  testedAt?: number;
}

const cache = new Map<string, CredentialProbeResult>();

function cacheKey(c: Pick<Credential, "provider" | "id">): string {
  return `${c.provider}::${c.id}`;
}

// Drains the cache when the user mutates credentials anywhere. The
// CredentialsListPanel already re-fetches the list on this same event,
// so the next render will trigger a fresh probe sweep.
if (typeof window !== "undefined") {
  window.addEventListener("jarela:credentials-changed", () => {
    cache.clear();
  });
}

async function runProbe(c: Credential): Promise<CredentialProbeResult> {
  try {
    const res = await api.integrations.test(c.provider, c.id);
    return res.ok
      ? { state: "ok", testedAt: Date.now() }
      : { state: "error", message: res.error ?? "Probe failed", testedAt: Date.now() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 404 — provider has no health probe registered. Treat as
    // "no opinion" rather than a failure so we don't paint every
    // non-LLM credential red.
    if (/^404\b/.test(msg)) {
      return { state: "unsupported", testedAt: Date.now() };
    }
    // 400 — unconfigured. Surfaces as red so the user knows the row is
    // saved but unusable (e.g. partial fields).
    return { state: "error", message: msg, testedAt: Date.now() };
  }
}

// Fan out probes across every credential the panel currently shows and
// return a stable Map by credential id. Re-runs only when the set of
// credential ids actually changes, NOT on every reference update.
export function useCredentialProbes(credentials: Credential[]): Map<string, CredentialProbeResult> {
  const [results, setResults] = useState<Map<string, CredentialProbeResult>>(() => {
    const m = new Map<string, CredentialProbeResult>();
    for (const c of credentials) {
      const cached = cache.get(cacheKey(c));
      if (cached) m.set(c.id, cached);
      else m.set(c.id, { state: "idle" });
    }
    return m;
  });

  // Build a stable join key so we only re-run when the set of credential
  // ids actually changes — the array reference flips on every refresh()
  // but the underlying ids usually don't.
  const idsKey = credentials.map((c) => c.id).sort().join("|");

  useEffect(() => {
    let cancelled = false;

    // Seed running state for any credential without a cached result.
    setResults((prev) => {
      const next = new Map(prev);
      for (const c of credentials) {
        const cached = cache.get(cacheKey(c));
        if (cached) next.set(c.id, cached);
        else if ((next.get(c.id) ?? { state: "idle" }).state === "idle") {
          next.set(c.id, { state: "running" });
        }
      }
      return next;
    });

    const pending = credentials.filter((c) => !cache.has(cacheKey(c)));
    if (pending.length === 0) return;

    void Promise.all(
      pending.map(async (c) => {
        const r = await runProbe(c);
        cache.set(cacheKey(c), r);
        if (cancelled) return;
        setResults((prev) => {
          const next = new Map(prev);
          next.set(c.id, r);
          return next;
        });
      }),
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  return results;
}
