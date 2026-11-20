/**
 * "Make it work" helpers: when a capability is enabled, install what it needs
 * instead of leaving it unavailable.
 *
 * Enabling is an explicit user intent, so the default is to fetch the
 * dependency. The trust model is unchanged — only allowlisted publishers
 * install unattended; anything else lands in the existing approval queue and
 * the caller reports `pending_approval`.
 *
 * Everything here is safe to call fire-and-forget:
 *   - single-flight per target (concurrent enables share one install),
 *   - a cooldown after a failure so a broken registry cannot be hammered on
 *     every turn,
 *   - the last outcome is cached for the UI to poll.
 */
import { installDependencies, type InstallOutcome } from "./install";
import { resolveDependencies, type DependencyTarget } from "./plan";
import type { DependencyStatus } from "./schema";

export type EnsureStatus =
  | "ready"
  | "installed"
  | "pending_approval"
  | "blocked"
  | "manual"
  | "failed"
  | "running";

export interface EnsureOutcome {
  target: DependencyTarget;
  status: EnsureStatus;
  /** Human-readable summary, safe to show in the UI. */
  message: string;
  install: InstallOutcome | null;
  missing: DependencyStatus[];
  checked_at: string;
}

const FAILURE_COOLDOWN_MS = 5 * 60_000;

const inFlight = new Map<string, Promise<EnsureOutcome>>();
const lastOutcome = new Map<string, EnsureOutcome & { at: number }>();

function targetKey(target: DependencyTarget): string {
  return `${target.kind}:${target.id}`;
}

function summarize(status: EnsureStatus, target: DependencyTarget, detail?: string): string {
  const label = `${target.kind}:${target.id}`;
  switch (status) {
    case "ready": return `${label} is ready.`;
    case "installed": return `Installed the dependencies for ${label}.`;
    case "pending_approval": return `${label} needs operator approval before its publisher can install.`;
    case "blocked": return `${label} cannot be installed automatically.`;
    case "manual": return `${label} requires a manual install outside Jarela.`;
    case "running": return `Installing the dependencies for ${label}…`;
    case "failed": return detail ?? `Could not install the dependencies for ${label}.`;
  }
}

function remember(outcome: EnsureOutcome): EnsureOutcome {
  lastOutcome.set(targetKey(outcome.target), { ...outcome, at: Date.now() });
  return outcome;
}

function cooldownFailure(target: DependencyTarget): EnsureOutcome | null {
  const previous = lastOutcome.get(targetKey(target));
  if (!previous) return null;
  if (Date.now() - previous.at > FAILURE_COOLDOWN_MS) return null;
  if (previous.status === "ready" || previous.status === "installed" || previous.status === "running") return null;
  return previous;
}

export interface EnsureOptions {
  /** Retry even if a previous attempt failed inside the cooldown window. */
  force?: boolean;
}

async function runEnsure(target: DependencyTarget, options: EnsureOptions): Promise<EnsureOutcome> {
  const resolution = await resolveDependencies(target, { force: true });
  const base = {
    target,
    install: null,
    missing: resolution.missing,
    checked_at: new Date().toISOString(),
  };

  switch (resolution.status) {
    case "ready":
    case "unverified":
      return remember({ ...base, status: "ready", message: summarize("ready", target) });
    case "unknown_target":
      return remember({ ...base, status: "failed", message: `${target.kind}:${target.id} is not a known target.` });
    case "manual":
      return remember({
        ...base,
        status: "manual",
        message: resolution.manual[0]?.hint ?? summarize("manual", target),
      });
    case "install_required":
      break;
  }

  const previous = options.force ? null : cooldownFailure(target);
  if (previous) return previous;

  const install = await installDependencies(target);
  const status: EnsureStatus =
    install.status === "installed" || install.status === "already_ready" ? "installed"
      : install.status === "pending_approval" ? "pending_approval"
        : install.status === "blocked" ? "blocked"
          : install.status === "manual" ? "manual"
            : "failed";

  return remember({
    ...base,
    status: status === "installed" ? (install.ran.length > 0 ? "installed" : "ready") : status,
    message: status === "failed" || status === "blocked"
      ? install.error ?? summarize(status, target)
      : summarize(status, target),
    install,
    missing: install.result.missing,
    checked_at: new Date().toISOString(),
  });
}

/** Install whatever `target` is missing. Single-flight and failure-cooled. */
export function ensureTarget(target: DependencyTarget, options: EnsureOptions = {}): Promise<EnsureOutcome> {
  const key = targetKey(target);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = runEnsure(target, options).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** Last observed outcome for a target, or null. */
export function getEnsureOutcome(target: DependencyTarget): EnsureOutcome | null {
  const entry = lastOutcome.get(targetKey(target));
  if (!entry) return null;
  const { at: _at, ...outcome } = entry;
  return outcome;
}

export function isEnsureRunning(target: DependencyTarget): boolean {
  return inFlight.has(targetKey(target));
}

/** Ensure several targets; failures do not abort the rest. */
export async function ensureTargets(
  targets: readonly DependencyTarget[],
  options: EnsureOptions = {},
): Promise<EnsureOutcome[]> {
  return Promise.all(targets.map((target) => ensureTarget(target, options)));
}

/** @internal — test-only. */
export function _resetEnsureState(): void {
  inFlight.clear();
  lastOutcome.clear();
}
