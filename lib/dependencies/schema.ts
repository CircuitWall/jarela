/**
 * Dependency declarations for optional tools and integrations — see
 * ADR-0121.
 *
 * A declaration answers two questions with data: *what* has to exist for a
 * capability to work, and *how* Jarela may obtain it. It never contains
 * commands, so a manifest cannot smuggle an executable string into the
 * installer; the kind decides both the probe and the install argv.
 *
 * This module is pure (zod + types only) so both the server runtime and the
 * extension manifests can import it without pulling in stores or processes.
 */
import { z } from "zod";

/** Kinds shipped in v1. `python-package` / `container-image` are deferred (ADR-0121). */
export const DEPENDENCY_KINDS = ["node-package", "executable", "node-runtime"] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/**
 * Where a node package lives.
 *
 * - `managed`   — installed into `$JARELA_PACKAGES_DIR` by Jarela.
 * - `workspace` — bundled with the app (the `@circuitwall/*` workspace
 *                 packages); installs use the same managed location so a
 *                 slim install can acquire it on demand.
 * - `global`    — a CLI installed with `npm install -g`.
 */
export const NODE_PACKAGE_SCOPES = ["managed", "workspace", "global"] as const;
export type NodePackageScope = (typeof NODE_PACKAGE_SCOPES)[number];

export const DependencySpecSchema = z
  .object({
    kind: z.enum(DEPENDENCY_KINDS),
    /**
     * `node-package`: npm package name. `executable`: binary name.
     * `node-runtime`: `"node"`.
     */
    id: z
      .string()
      .min(1)
      .max(214)
      // Package names and binary names only — no paths, no shell metacharacters.
      .regex(/^@?[A-Za-z0-9._~/-]+$/, "dependency id must be a package or binary name"),
    /** `node-package` only. Defaults to `managed`. */
    scope: z.enum(NODE_PACKAGE_SCOPES).optional(),
    /** `node-package` (global) only: the CLI this package installs. */
    bin: z.string().min(1).max(64).regex(/^[A-Za-z0-9._~-]+$/).optional(),
    /** `node-runtime`: a semver range, e.g. `^24.15.0 || >=26.0.0`. */
    version: z.string().min(1).max(128).optional(),
    /**
     * `false` marks an informational dependency: it is reported but never
     * blocks the tool. Default `true`.
     */
    required: z.boolean().optional(),
    /** Short, user-facing install/upgrade instruction. */
    hint: z.string().min(1).max(500).optional(),
    docs_url: z.string().url().optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.kind !== "node-package" && spec.scope !== undefined) {
      ctx.addIssue({ code: "custom", path: ["scope"], message: "scope applies to node-package only" });
    }
    if (spec.kind !== "node-package" && spec.bin !== undefined) {
      ctx.addIssue({ code: "custom", path: ["bin"], message: "bin applies to node-package only" });
    }
    if (spec.kind === "node-runtime") {
      if (spec.version === undefined) {
        ctx.addIssue({ code: "custom", path: ["version"], message: "node-runtime requires a version range" });
      }
      if (spec.id !== "node") {
        ctx.addIssue({ code: "custom", path: ["id"], message: 'node-runtime id must be "node"' });
      }
    }
  });

export type DependencySpec = z.infer<typeof DependencySpecSchema>;

export const DependencySpecListSchema = z.array(DependencySpecSchema).max(32);

export function parseDependencySpecs(input: unknown): DependencySpec[] {
  if (input === undefined || input === null) return [];
  return DependencySpecListSchema.parse(input);
}

export function safeParseDependencySpecs(input: unknown): DependencySpec[] {
  const parsed = DependencySpecListSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  console.warn(`[dependencies] ignoring invalid dependency declarations: ${parsed.error.message}`);
  return [];
}

// ── Probe results ─────────────────────────────────────────────────────

/**
 * `unverified` means the probe could not decide (transient spawn/fs error, or
 * it has not run yet). Like readiness in `lib/health/probe-cache.ts`, it never
 * hides a tool.
 */
export const DEPENDENCY_STATES = ["satisfied", "missing", "unverified"] as const;
export type DependencyState = (typeof DEPENDENCY_STATES)[number];

export interface DependencyStatus {
  kind: DependencyKind;
  id: string;
  scope: NodePackageScope | null;
  state: DependencyState;
  /** True when Jarela can install it after an explicit request. */
  installable: boolean;
  /** Machine-readable explanation of the state, e.g. `not-on-path`. */
  detail: string | null;
  required: boolean;
  hint: string | null;
  docs_url: string | null;
  checked_at: string;
}

export type DependencyReadiness = "ready" | "missing" | "unverified";

/** Stable cache/identity key for a spec. */
export function dependencyKey(spec: DependencySpec): string {
  const scope = spec.kind === "node-package" ? (spec.scope ?? "managed") : "";
  return [spec.kind, spec.id, scope, spec.version ?? "", spec.bin ?? ""].join("|");
}

/** Human label for UI rows and error messages. */
export function dependencyLabel(spec: Pick<DependencySpec, "kind" | "id" | "scope" | "bin">): string {
  if (spec.kind === "node-runtime") return "Node.js runtime";
  if (spec.kind === "executable") return spec.id;
  const scope = spec.scope ?? "managed";
  return scope === "global" && spec.bin ? `${spec.id} (${spec.bin})` : spec.id;
}

export function isRequired(spec: DependencySpec): boolean {
  return spec.required !== false;
}

/**
 * Package root of an npm specifier, dropping subpaths and versions.
 * `@scope/pkg/sub` → `@scope/pkg`; `pkg@1.2.3` → `pkg`.
 */
export function packageRootOf(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed === "") return trimmed;
  const segments = trimmed.split("/");
  if (trimmed.startsWith("@")) {
    const scope = segments[0] ?? "";
    const name = segments[1] ?? "";
    const at = name.indexOf("@");
    return at > 0 ? `${scope}/${name.slice(0, at)}` : `${scope}/${name}`;
  }
  const first = segments[0] ?? trimmed;
  const at = first.indexOf("@");
  return at > 0 ? first.slice(0, at) : first;
}
