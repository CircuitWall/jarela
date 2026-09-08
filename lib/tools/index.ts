// Public tool surface for the agent runtime.
// The implementation is grouped under ./core to keep this compatibility
// facade stable for existing imports.

export * from "./runtime/types";
export { getToolsDir, type ExtensionLoadError } from "./runtime/external";
export {
  loadLangChainPackages,
  reloadLangChainPackages,
  getPackagesDir,
  type LangChainPackageManifest,
  type LangChainPackageLoadResult,
  type LangChainPackageLoadError,
} from "./packages/langchain-packages";
export {
  registerTools,
  type Capability,
  type ToolCategory,
  type ToolGroup,
} from "./runtime/registry";
export * from "./core";
