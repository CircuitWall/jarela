/**
 * Dependency plans — turn an enabling target into "what is missing, and what
 * would fix it".
 *
 * Targets name the thing the user is trying to turn on:
 *
 *   tool:<name>          a registered built-in / package tool
 *   integration:<id>     an integration manifest
 *   package:<id>         a bundled default package
 *   manifest:<name>      an operator-authored npm manifest
 *   mcp:<name>           a configured MCP server
 *
 * The plan is pure data: probe results plus the exact argv Jarela would run.
 * Nothing here executes an install — see `lib/dependencies/install.ts` for the
 * executor and ADR-0121 for the trust model.
 */
import { getManifest as getIntegrationManifest } from "@/lib/integrations/registry";
import { getMcpServer } from "@/lib/stores/mcp-servers";
import { defaultPackageDependencies } from "@/lib/tools/packages/default-packages";
import { getManifest as getNpmManifest } from "@/lib/tools/packages/package-manifests";
import { getPackagesDir, manifestDependencies } from "@/lib/tools/packages/langchain-packages";
import { isPackageAllowed } from "@/lib/tools/packages/package-allowlist";
import { registeredCategory, registeredDependencies } from "@/lib/tools/runtime/registry";
import {
  anyMissingDependencyInstallable,
  missingDependencies,
  probeDependencies,
  summarizeDependencies,
} from "./probe";
import type { DependencySpec, DependencyStatus } from "./schema";
import { findOptionalPackage } from "./optional-catalog";

export const DEPENDENCY_TARGET_KINDS = ["tool", "integration", "package", "manifest", "mcp", "runtime"] as const;
export type DependencyTargetKind = (typeof DEPENDENCY_TARGET_KINDS)[number];

export interface DependencyTarget {
  kind: DependencyTargetKind;
  id: string;
}

export type DependencyPlanStatus =
  | "ready"
  | "unverified"
  | "install_required"
  | "manual"
  | "unknown_target";

export interface InstallStep {
  dependency: DependencyStatus;
  spec: DependencySpec;
  /** Full argv, including the manager name. Never run through a shell. */
  command: string[];
  /** Working directory, or null for global installs. */
  cwd: string | null;
  publisher: string;
  allowlisted: boolean;
}

export interface DependencyResolution {
  target: DependencyTarget;
  status: DependencyPlanStatus;
  dependencies: DependencyStatus[];
  missing: DependencyStatus[];
  steps: InstallStep[];
  manual: DependencyStatus[];
}

export function parseTarget(raw: string): DependencyTarget | null {
  const trimmed = raw.trim();
  const at = trimmed.indexOf(":");
  if (at <= 0) return null;
  const kind = trimmed.slice(0, at);
  const id = trimmed.slice(at + 1).trim();
  if (!id) return null;
  if (!(DEPENDENCY_TARGET_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as DependencyTargetKind, id };
}

export function formatTarget(target: DependencyTarget): string {
  return `${target.kind}:${target.id}`;
}

const MCP_RUNTIME_COMMANDS = new Set(["npx", "uvx", "bunx", "pnpm", "docker"]);

function mcpDependencies(name: string): DependencySpec[] {
  const server = getMcpServer(name);
  if (!server || server.transport !== "stdio") return [];
  let command: unknown;
  try {
    command = (JSON.parse(server.spec) as { command?: unknown }).command;
  } catch {
    return [];
  }
  if (typeof command !== "string" || command.trim() === "") return [];
  const binary = command.trim().split(/[\\/]/).pop() ?? command.trim();
  if (!MCP_RUNTIME_COMMANDS.has(binary)) return [];
  return [
    {
      kind: "executable",
      id: binary,
      hint: `The MCP server "${name}" runs through ${binary}. Install it and make sure it is on PATH.`,
    },
  ];
}

/**
 * Dependency declarations for a target. Unknown ids resolve to `[]`, which the
 * caller reports as `unknown_target` rather than "ready".
 */
export function specsForTarget(target: DependencyTarget): DependencySpec[] | null {
  switch (target.kind) {
    case "tool": {
      if (!registeredCategory(target.id)) return null;
      return [...registeredDependencies(target.id)];
    }
    case "integration": {
      const manifest = getIntegrationManifest(target.id);
      return manifest ? [...(manifest.dependencies ?? [])] : null;
    }
    case "package": {
      const specs = defaultPackageDependencies(target.id);
      return specs.length > 0 ? specs : null;
    }
    case "manifest": {
      const record = getNpmManifest(target.id);
      return record ? manifestDependencies(record.manifest) : null;
    }
    case "mcp": {
      const server = getMcpServer(target.id);
      return server ? mcpDependencies(target.id) : null;
    }
    case "runtime": {
      // On-demand runtimes belong to no single tool or integration (ADR-0122).
      // Only catalogue entries are installable this way, so the target cannot
      // be used to pull an arbitrary allowlisted package.
      const entry = findOptionalPackage(target.id);
      return entry ? [entry.spec] : null;
    }
  }
}

function specWithVersion(spec: DependencySpec): string {
  return spec.version ? `${spec.id}@${spec.version}` : spec.id;
}

/** The argv Jarela would run for one dependency, or null when manual. */
export function buildInstallStep(
  spec: DependencySpec,
  status: DependencyStatus,
): InstallStep | null {
  if (spec.kind !== "node-package") return null;
  const scope = spec.scope ?? "managed";
  const command = scope === "global"
    ? ["npm", "install", "-g", "--no-fund", "--no-audit", specWithVersion(spec)]
    : ["npm", "install", "--save", "--no-fund", "--no-audit", specWithVersion(spec)];
  const decision = isPackageAllowed(spec.id);
  return {
    dependency: status,
    spec,
    command,
    cwd: scope === "global" ? null : getPackagesDir(),
    publisher: decision.publisher,
    allowlisted: decision.allowed,
  };
}

export interface ResolveOptions {
  /** Bypass the probe cache (used right before/after an install). */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export async function resolveDependencies(
  target: DependencyTarget,
  options: ResolveOptions = {},
): Promise<DependencyResolution> {
  const specs = specsForTarget(target);
  if (specs === null) {
    return { target, status: "unknown_target", dependencies: [], missing: [], steps: [], manual: [] };
  }
  if (specs.length === 0) {
    return { target, status: "ready", dependencies: [], missing: [], steps: [], manual: [] };
  }

  const statuses = await probeDependencies(specs, options);
  const missing = missingDependencies(statuses);
  if (missing.length === 0) {
    return {
      target,
      status: summarizeDependencies(statuses) === "unverified" ? "unverified" : "ready",
      dependencies: statuses,
      missing: [],
      steps: [],
      manual: [],
    };
  }

  const steps: InstallStep[] = [];
  const manual: DependencyStatus[] = [];
  for (const status of missing) {
    const spec = specs.find((s) => s.id === status.id && s.kind === status.kind);
    const step = spec ? buildInstallStep(spec, status) : null;
    if (step) steps.push(step);
    else manual.push(status);
  }

  const status: DependencyPlanStatus = manual.length > 0
    ? "manual"
    : anyMissingDependencyInstallable(statuses)
      ? "install_required"
      : "manual";

  return { target, status, dependencies: statuses, missing, steps, manual };
}
