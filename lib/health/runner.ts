// Periodic health-probe runner. Iterates the registered probes from
// ./probes.ts, races each against a short timeout, and translates state
// transitions into `health_alert` notification events.
//
// Why state transitions: the probe pool runs every ~10min server-side and
// can also be triggered on demand. Without dedup the user would see the
// same "Atlassian rejected the token" toast every cycle until they fixed
// it. We publish:
//   * fail → first failure since last success, OR every RE_ALERT_MS while
//            still failing (so the user is reminded the integration is
//            still broken even if they dismissed the toast).
//   * recovered → the probe that was failing is now green again.
//
// "Unconfigured" probes (operator never set the credential) are silently
// ignored — only configured-but-broken probes alert. State lives on
// globalThis (per-process, in-memory) so a restart re-evaluates from
// scratch.

import { publish } from "@/lib/notifications/bus";
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import {
  listProbes,
  probeCategory,
  probeLabel,
  runProbe,
  type HealthResult,
  type ProbeName,
} from "./probes";
import { errorMessage } from "@/lib/utils/error";

const RE_ALERT_MS = 30 * 60 * 1000; // re-fire after 30 min of continuous failure

export interface ProbeState {
  name: ProbeName;
  category: "integration" | "llm";
  label: string;
  lastResult: HealthResult | null;
  lastCheckedAt: number;
  // null when never failed; set to first-failure timestamp while failing.
  failingSince: number | null;
  // last time we published an alert for this probe — drives the re-alert
  // backoff. Reset to 0 on recovery.
  lastAlertAt: number;
}

interface RunnerState {
  probes: Map<ProbeName, ProbeState>;
  lastRunAt: number;
  // Set while a run is in flight so two concurrent triggers (scheduler +
  // /api/v1/health?refresh=1) don't double-probe every vendor.
  inFlight: boolean;
}

const state = getOrCreateGlobal<RunnerState>("__jarela_health_runner", () => ({
  probes: new Map(),
  lastRunAt: 0,
  inFlight: false,
}));

function getOrInit(name: ProbeName): ProbeState {
  let s = state.probes.get(name);
  if (!s) {
    s = {
      name,
      category: probeCategory(name),
      label: probeLabel(name),
      lastResult: null,
      lastCheckedAt: 0,
      failingSince: null,
      lastAlertAt: 0,
    };
    state.probes.set(name, s);
  }
  return s;
}

// Public: snapshot for the /api/v1/health route.
export interface HealthSnapshot {
  ranAt: number;
  probes: Array<{
    name: string;
    category: "integration" | "llm";
    label: string;
    status: HealthResult["status"] | "never_checked";
    ok: boolean;
    error: string | null;
    detail: Record<string, unknown> | null;
    lastCheckedAt: number;
    failingSince: number | null;
  }>;
}

export function getHealthSnapshot(): HealthSnapshot {
  const probes: HealthSnapshot["probes"] = [];
  for (const name of listProbes()) {
    const s = state.probes.get(name);
    if (!s) {
      probes.push({
        name,
        category: probeCategory(name),
        label: probeLabel(name),
        status: "never_checked",
        ok: false,
        error: null,
        detail: null,
        lastCheckedAt: 0,
        failingSince: null,
      });
      continue;
    }
    probes.push({
      name: s.name,
      category: s.category,
      label: s.label,
      status: s.lastResult?.status ?? "never_checked",
      ok: s.lastResult?.ok ?? false,
      error: s.lastResult?.error ?? null,
      detail: s.lastResult?.detail ?? null,
      lastCheckedAt: s.lastCheckedAt,
      failingSince: s.failingSince,
    });
  }
  return { ranAt: state.lastRunAt, probes };
}

// Publish-vs-skip decision for a single probe transition.
function reconcileProbe(s: ProbeState, prev: HealthResult | null, next: HealthResult, now: number): void {
  if (next.ok) {
    if (s.failingSince !== null) {
      // Was failing, now green — publish a one-shot recovery.
      publish({
        type: "health_alert",
        probe: s.name,
        label: s.label,
        category: s.category,
        status: "recovered",
        error: null,
        ts: now,
      });
    }
    s.failingSince = null;
    s.lastAlertAt = 0;
    return;
  }
  // Unconfigured probes never alert — operator hasn't configured them.
  if (next.status === "unconfigured") {
    s.failingSince = null;
    s.lastAlertAt = 0;
    return;
  }
  // Failing: alert on first failure since last green, OR on re-alert
  // interval. Don't compare equal error strings — a flapping vendor
  // shouldn't fall through the cracks.
  const wasFailing = s.failingSince !== null;
  if (!wasFailing) s.failingSince = now;
  const sinceLastAlert = now - s.lastAlertAt;
  const shouldAlert = !wasFailing || sinceLastAlert >= RE_ALERT_MS;
  if (shouldAlert) {
    s.lastAlertAt = now;
    // Tag transient/error/auth_failed verbatim so the UI can colour-code.
    const alertStatus = next.status === "auth_failed" ? "auth_failed"
      : next.status === "transient" ? "transient" : "error";
    publish({
      type: "health_alert",
      probe: s.name,
      label: s.label,
      category: s.category,
      status: alertStatus,
      error: next.error ?? "probe failed",
      ts: now,
    });
  }
  // Keep prev referenced for future diff logic without leaking unused param.
  void prev;
}

/**
 * Run every registered probe in parallel and reconcile state. Returns the
 * fresh snapshot. Safe to call concurrently — re-entrant calls return the
 * stale snapshot until the in-flight run finishes.
 */
export async function runAllHealthProbes(now: number = Date.now()): Promise<HealthSnapshot> {
  if (state.inFlight) return getHealthSnapshot();
  state.inFlight = true;
  try {
    const probes = listProbes();
    const results = await Promise.allSettled(probes.map((p) => runProbe(p)));
    for (let i = 0; i < probes.length; i++) {
      const name = probes[i];
      const s = getOrInit(name);
      const r = results[i];
      const next: HealthResult = r.status === "fulfilled"
        ? r.value
        : { ok: false, status: "error", error: errorMessage(r.reason) };
      const prev = s.lastResult;
      s.lastResult = next;
      s.lastCheckedAt = now;
      reconcileProbe(s, prev, next, now);
    }
    state.lastRunAt = now;
    return getHealthSnapshot();
  } finally {
    state.inFlight = false;
  }
}

/** Exposed for tests so they can reset state between cases. */
export function _resetHealthRunner(): void {
  state.probes.clear();
  state.lastRunAt = 0;
  state.inFlight = false;
}
