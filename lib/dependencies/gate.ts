/**
 * Enable gate — the one place that decides whether a feature may be turned on.
 *
 * Enabling surfaces call this before flipping a flag (ADR-0121):
 *
 *   - dependencies satisfied (or `unverified`) → enabling proceeds;
 *   - dependencies missing and installable → `install_required`, or install on
 *     request when the caller passed `installMissing`;
 *   - dependencies missing and operator-owned → `manual`;
 *   - install refused/failed → the observed reason, never a silent flip.
 *
 * `unverified` allows the enable on purpose: a probe that could not decide must
 * not block configuration the operator is actively asking for.
 */
import { installDependencies, type InstallOutcome } from "./install";
import { resolveDependencies, type DependencyResolution, type DependencyTarget } from "./plan";

export type EnableGateReason = "ready" | "install_required" | "manual" | "blocked" | "failed" | "unknown_target";

export interface EnableGateResult {
  ok: boolean;
  resolution: DependencyResolution;
  install: InstallOutcome | null;
  reason: EnableGateReason;
}

export async function gateEnable(
  target: DependencyTarget,
  options: { installMissing?: boolean; timeoutMs?: number } = {},
): Promise<EnableGateResult> {
  const resolution = await resolveDependencies(target, { force: true });

  switch (resolution.status) {
    case "ready":
    case "unverified":
      return { ok: true, resolution, install: null, reason: "ready" };
    case "unknown_target":
      return { ok: false, resolution, install: null, reason: "unknown_target" };
    case "manual":
      return { ok: false, resolution, install: null, reason: "manual" };
    case "install_required":
      break;
  }

  if (!options.installMissing) {
    return { ok: false, resolution, install: null, reason: "install_required" };
  }

  const install = await installDependencies(target, { timeoutMs: options.timeoutMs });
  const ok = install.status === "installed" || install.status === "already_ready";
  const reason: EnableGateReason = ok
    ? "ready"
    : install.status === "pending_approval"
      ? "install_required"
      : install.status === "manual"
        ? "manual"
        : install.status === "blocked"
          ? "blocked"
          : "failed";
  return { ok, resolution: install.result, install, reason };
}
