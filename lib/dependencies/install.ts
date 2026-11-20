/**
 * Dependency installer — the only place that turns a plan into processes.
 *
 * Trust model (ADR-0121, shared with the package installer):
 *
 *   - allowlisted publishers (`package-allowlist.ts`) install immediately when
 *     an operator asks for them;
 *   - a non-allowlisted *managed* package goes through the existing
 *     `beginInstall` pending-approval queue, so nothing reaches `npm` until the
 *     operator approves it;
 *   - a non-allowlisted *global* package is refused — approving a global
 *     install is an operator action outside Jarela's package queue.
 *
 * Commands are argv arrays spawned without a shell. After a run the probe cache
 * and both registries are refreshed, and the plan is re-resolved so the caller
 * reports the observed outcome rather than the intent.
 */
import { reloadDefaultPackages } from "@/lib/tools/packages/default-packages";
import { reloadLangChainPackages } from "@/lib/tools/packages/langchain-packages";
import { beginInstall, type PendingInstall } from "@/lib/tools/packages/package-install";
import { runCommand, type CommandRunner } from "./run-command";
import { invalidateDependencyStatuses } from "./probe";
import {
  resolveDependencies,
  type DependencyResolution,
  type DependencyTarget,
  type InstallStep,
} from "./plan";

const DEFAULT_TIMEOUT_MS = 180_000;

let runner: CommandRunner = runCommand;

export type InstallOutcomeStatus =
  | "installed"
  | "already_ready"
  | "pending_approval"
  | "blocked"
  | "manual"
  | "failed";

export interface InstallOutcome {
  target: DependencyTarget;
  status: InstallOutcomeStatus;
  /** Plan before the attempt, so the caller can show what it tried. */
  plan: DependencyResolution;
  /** Plan re-resolved after the attempt. */
  result: DependencyResolution;
  ran: Array<{ command: string[]; cwd: string | null }>;
  pending: PendingInstall[];
  /** Steps Jarela refuses to run, with the reason. */
  blocked: Array<{ step: InstallStep; reason: string }>;
  error: string | null;
}

type StepOutcome =
  | { kind: "ran" }
  | { kind: "pending"; pending: PendingInstall }
  | { kind: "blocked"; reason: string };

async function runStep(step: InstallStep, timeoutMs: number): Promise<StepOutcome> {
  if (step.allowlisted) {
    await runner(step.command, step.cwd, timeoutMs);
    return { kind: "ran" };
  }
  if (step.cwd !== null) {
    // Managed packages reuse the existing approval queue.
    const outcome = await beginInstall({ spec: step.dependency.id, version: step.spec.version });
    if (outcome.status === "pending") return { kind: "pending", pending: outcome.pending };
    return { kind: "ran" };
  }
  return {
    kind: "blocked",
    reason: `Publisher "${step.publisher}" is not allowlisted and this is a global install \u2014 run it yourself: ${step.command.join(" ")}`,
  };
}

async function refreshAfterInstall(): Promise<void> {
  invalidateDependencyStatuses();
  try {
    await reloadLangChainPackages();
  } catch (err) {
    console.error("[dependencies] package reload failed after install:", err);
  }
  reloadDefaultPackages();
}

export async function installDependencies(
  target: DependencyTarget,
  options: { timeoutMs?: number } = {},
): Promise<InstallOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const plan = await resolveDependencies(target, { force: true });
  const base: InstallOutcome = {
    target,
    status: "already_ready",
    plan,
    result: plan,
    ran: [],
    pending: [],
    blocked: [],
    error: null,
  };

  if (plan.status === "ready") return base;
  if (plan.status === "manual") return { ...base, status: "manual" };
  if (plan.status === "unknown_target") {
    return { ...base, status: "failed", error: `unknown dependency target: ${target.kind}:${target.id}` };
  }

  let firstError: string | null = null;
  for (const step of plan.steps) {
    try {
      const outcome = await runStep(step, timeoutMs);
      if (outcome.kind === "ran") base.ran.push({ command: step.command, cwd: step.cwd });
      if (outcome.kind === "pending") base.pending.push(outcome.pending);
      if (outcome.kind === "blocked") base.blocked.push({ step, reason: outcome.reason });
    } catch (err) {
      firstError ??= err instanceof Error ? err.message : String(err);
      break;
    }
  }

  if (base.ran.length > 0) await refreshAfterInstall();
  const result = await resolveDependencies(target, { force: true });

  if (result.status === "ready") return { ...base, status: "installed", result };
  if (base.blocked.length > 0) {
    return { ...base, status: "blocked", result, error: firstError ?? base.blocked[0]!.reason };
  }
  if (base.pending.length > 0) return { ...base, status: "pending_approval", result };
  return {
    ...base,
    status: "failed",
    result,
    error: firstError ?? "install finished but the dependency is still unavailable",
  };
}

/** @internal — test seam for the process runner. */
export function _setInstallRunnerForTests(fn: CommandRunner | null): void {
  runner = fn ?? runCommand;
}
