/**
 * Non-blocking readiness cache for integration probes.
 *
 * `getAllToolCatalogAsync()` runs on every agent turn, so it cannot await a
 * network probe. Readiness is therefore read from an in-memory cache that is
 * refreshed lazily in the background: the first read reports "unknown" and
 * schedules a probe, and later reads see the result until the TTL expires.
 *
 * "unknown" never hides a tool. Only a probe that came back `unconfigured` or
 * `auth_failed` does; `transient` and `error` are treated as noise so a flaky
 * network cannot make an agent's toolset disappear mid-conversation.
 */
import { isIntegrationProbe, runProbe } from "./probes";

export type IntegrationReadiness = "ready" | "unconfigured" | "unknown";

const TTL_MS = 5 * 60_000;

interface CacheEntry {
  readiness: "ready" | "unconfigured";
  checkedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Set<string>();

// Probes hit the network and spawn helpers; unit tests must stay hermetic.
function backgroundRefreshEnabled(): boolean {
  return process.env.NODE_ENV !== "test" && process.env.JARELA_DISABLE_PROBE_CACHE !== "1";
}

function scheduleRefresh(id: string): void {
  if (!backgroundRefreshEnabled() || inFlight.has(id)) return;
  inFlight.add(id);
  void (async () => {
    try {
      const result = await runProbe(id as Parameters<typeof runProbe>[0]);
      if (result.status === "ok") {
        cache.set(id, { readiness: "ready", checkedAt: Date.now() });
      } else if (result.status === "unconfigured" || result.status === "auth_failed") {
        cache.set(id, { readiness: "unconfigured", checkedAt: Date.now() });
      } else {
        // transient/error: keep whatever we had, just restart the TTL clock.
        const previous = cache.get(id);
        cache.set(id, { readiness: previous?.readiness ?? "ready", checkedAt: Date.now() });
      }
    } catch {
      cache.set(id, { readiness: cache.get(id)?.readiness ?? "ready", checkedAt: Date.now() });
    } finally {
      inFlight.delete(id);
    }
  })();
}

export function getIntegrationReadiness(id: string | null | undefined): IntegrationReadiness {
  if (!id || !isIntegrationProbe(id)) return "unknown";
  const hit = cache.get(id);
  if (!hit) {
    scheduleRefresh(id);
    return "unknown";
  }
  if (Date.now() - hit.checkedAt > TTL_MS) scheduleRefresh(id);
  return hit.readiness;
}

/** Drop cached readiness so the next read re-probes. Call after credential writes. */
export function invalidateIntegrationReadiness(id?: string): void {
  if (id) cache.delete(id);
  else cache.clear();
}

/** @internal — test-only seam for asserting on catalog filtering. */
export function _setIntegrationReadiness(id: string, readiness: "ready" | "unconfigured"): void {
  cache.set(id, { readiness, checkedAt: Date.now() });
}
