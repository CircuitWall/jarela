/**
 * Composition root and lifecycle manager for bundled LangChain packages.
 * Package-specific tools and auth wiring live in ./default-packages/<id>.ts.
 */
import { isOptionalPackageInstalled } from "./optional-package";
import type { RegisteredPackage } from "./langchain-package";
import { setPackageAuthResolver } from "../runtime/auth-registry";
import { setToolDependencies } from "../runtime/registry";
import { isPackageDisabled } from "@/lib/stores/disabled-packages";
import type { DependencySpec } from "@/lib/dependencies/schema";
import type { DefaultPackageDescriptor, DefaultPackageInfo } from "./default-packages/types";
import { atlassianDefaultPackage } from "./default-packages/atlassian";
import { githubDefaultPackage } from "./default-packages/github";
import { icloudDefaultPackages } from "./default-packages/icloud";
import { jiraAlignDefaultPackage } from "./default-packages/jira-align";

export type { DefaultPackageDescriptor, DefaultPackageInfo } from "./default-packages/types";

/** Dependency specs for one bundled package, or `[]` for an unknown id. */
export function defaultPackageDependencies(id: string): DependencySpec[] {
  const descriptor = DESCRIPTORS.find((d) => d.id === id);
  return descriptor ? dependenciesFor(descriptor) : [];
}

const DESCRIPTORS: readonly DefaultPackageDescriptor[] = [
  atlassianDefaultPackage,
  githubDefaultPackage,
  jiraAlignDefaultPackage,
  ...icloudDefaultPackages,
];

const handles = new Map<string, RegisteredPackage<unknown>>();

/**
 * Dependencies a bundled package needs before its tools can run (ADR-0121).
 * `workspace` keeps the dev/bundled resolution path while still allowing the
 * managed install location to satisfy a slim install.
 */
function dependenciesFor(descriptor: DefaultPackageDescriptor): DependencySpec[] {
  return [{ kind: "node-package", id: descriptor.npmPackage, scope: "workspace" }];
}

/** Register every default package whose disable flag is unset. Idempotent. */
export function registerDefaultPackages(): void {
  for (const descriptor of DESCRIPTORS) {
    if (handles.has(descriptor.id)) continue;
    if (isPackageDisabled(descriptor.id)) continue;
    registerOne(descriptor);
  }
}

/** Catalogue used by the API + UI; status reflects the live registry. */
export function listDefaultPackages(): DefaultPackageInfo[] {
  return DESCRIPTORS.map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    category: descriptor.category,
    integrationId: descriptor.integrationId,
    npmPackage: descriptor.npmPackage,
    toolCounts: descriptor.toolCounts,
    description: descriptor.description,
    enabled: !isPackageDisabled(descriptor.id),
    installed: isOptionalPackageInstalled(descriptor.npmPackage),
    dependencies: dependenciesFor(descriptor),
  }));
}

export function findDefaultPackage(id: string): DefaultPackageDescriptor | null {
  return DESCRIPTORS.find((descriptor) => descriptor.id === id) ?? null;
}

/**
 * Register or unregister a single default package on demand. Used by
 * the API toggle endpoint so a flip takes effect without a restart.
 */
export function setDefaultPackageEnabled(id: string, enabled: boolean): boolean {
  const descriptor = findDefaultPackage(id);
  if (!descriptor) return false;
  if (enabled) {
    if (!handles.has(id)) registerOne(descriptor);
  } else {
    const handle = handles.get(id);
    if (handle) {
      handle.unregister();
      handles.delete(id);
    }
  }
  return true;
}

/** Re-read optional package modules after an install or uninstall. */
export function reloadDefaultPackages(): void {
  _resetDefaultPackages();
  registerDefaultPackages();
}

function registerOne(descriptor: DefaultPackageDescriptor): void {
  const handle = descriptor.register();
  handles.set(descriptor.id, handle);
  setPackageAuthResolver(descriptor.integrationId, handle.resolveAuth);
  setToolDependencies(handle.toolNames, dependenciesFor(descriptor));
}

/** @internal — test-only. */
export function _resetDefaultPackages(): void {
  for (const handle of handles.values()) handle.unregister();
  handles.clear();
}
