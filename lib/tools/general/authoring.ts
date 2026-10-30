import { tool } from "@langchain/core/tools";
import { ScaffoldExtensionInput, ContributionBundleInput, scaffoldExtension, prepareContributionBundle } from "@/lib/workflows/authoring";
import { registerLangChainPackage } from "../packages/langchain-package";

export const scaffoldExtensionTool = tool(async (input) => JSON.stringify(scaffoldExtension(input)), {
  name: "scaffold_extension",
  description: "Build an inert dependency-free external-tool template, synthetic local-service tests and review/setup/recovery notes. Discover existing capabilities first; only decision=author produces files. Returns bounded text and an exact revision, never writes/imports/tests/installs/enables code. The template is a local synthetic example, not implementation of the stated goal. Discovery evidence is caller-supplied, not verified. Separate code-execution and installation approval remain required.",
  schema: ScaffoldExtensionInput,
});
export const prepareContributionBundleTool = tool(async (input) => JSON.stringify(prepareContributionBundle(input)), {
  name: "prepare_contribution_bundle",
  description: "Build a local-only review bundle and exact outgoing patch from bounded supplied before/after text, destination, base revision, branch, rights and reported tests. Blocks dirty/unknown worktree reports, failed/unrun tests, unknown rights, unsafe paths and common sensitive markers. Does not read git/files, verify reported evidence, prove sanitization or send anything. Human privacy review and separate exact commit/push/draft-PR authorization are mandatory; local execution trust never grants publication rights.",
  schema: ContributionBundleInput,
});
registerLangChainPackage({ category: "Config", tools: { read: [scaffoldExtensionTool, prepareContributionBundleTool] } });
