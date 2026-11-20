/**
 * Optional tool / integration dependencies — see ADR-0121.
 *
 * - `schema`     declarations + probe result types (pure).
 * - `probe`      "is it installed?" with caching and test seams.
 * - `plan`       target → ready / install_required / manual.
 *
 * Consumers import the narrow module they need (`probe` from the tool
 * catalog, `plan` from the enabling routes) so this facade stays a convenience
 * surface rather than a second entry point that everything funnels through.
 */
export * from "./schema";
export {
  anyMissingDependencyInstallable,
  firstMissingDependency,
  getCachedDependencyStatus,
  invalidateDependencyStatuses,
  missingDependencies,
  missingDependencyMessage,
  probeDependencies,
  probeDependency,
  summarizeDependencies,
} from "./probe";
export {
  DEPENDENCY_TARGET_KINDS,
  buildInstallStep,
  formatTarget,
  parseTarget,
  resolveDependencies,
  specsForTarget,
  type DependencyPlanStatus,
  type DependencyResolution,
  type DependencyTarget,
  type DependencyTargetKind,
  type InstallStep,
  type ResolveOptions,
} from "./plan";
export { installDependencies, type InstallOutcome, type InstallOutcomeStatus } from "./install";
