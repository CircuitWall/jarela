/**
 * Catalogue of optional, on-demand packages (ADR-0122).
 *
 * The point of this module is expectation-setting: a user should be able to
 * see, *by category*, what can be installed later, how big it is, and what
 * keeps working without it. It is also the allowlist for the `runtime:<id>`
 * dependency target — only listed packages may be installed that way.
 *
 * Add an entry only when the package is genuinely optional. A package that is
 * still a hard dependency belongs in the install docs, not here.
 */
import { DependencySpecSchema, type DependencySpec } from "./schema";

export const OPTIONAL_PACKAGE_CATEGORIES = [
  "embeddings",
  "agent-runtimes",
  "messaging",
  "connectors",
] as const;

export type OptionalPackageCategory = (typeof OPTIONAL_PACKAGE_CATEGORIES)[number];

export const OPTIONAL_PACKAGE_CATEGORY_LABELS: Record<OptionalPackageCategory, string> = {
  embeddings: "Embeddings and recall",
  "agent-runtimes": "Agent runtimes",
  messaging: "Messaging bridges",
  connectors: "Work connectors",
};

export interface OptionalPackageEntry {
  /** npm package name; also the id of the `runtime:<id>` target. */
  id: string;
  category: OptionalPackageCategory;
  label: string;
  /** One line: what installing it turns on. */
  summary: string;
  /** What keeps working (or degrades) while it is not installed. */
  withoutIt: string;
  /** Approximate installed size in MB, measured on a development checkout. */
  sizeMb: number;
  docsUrl?: string;
  spec: DependencySpec;
}

/**
 * Measured sizes (ADR-0122). Keep `sizeMb` in whole megabytes so the UI can
 * say "≈426 MB" without implying false precision.
 */
export const OPTIONAL_PACKAGES: readonly OptionalPackageEntry[] = [
  {
    id: "@huggingface/transformers",
    category: "embeddings",
    label: "Local embeddings",
    summary: "Runs the bundled multilingual embedding model locally for semantic recall and search.",
    withoutIt: "Recall and document search use lexical matching only. Indexing, chat, and every other tool are unaffected.",
    sizeMb: 426,
    docsUrl: "https://www.npmjs.com/package/@huggingface/transformers",
    spec: DependencySpecSchema.parse({
      kind: "node-package",
      id: "@huggingface/transformers",
      scope: "managed",
      hint: "Install local embeddings from Settings → Tools → Packages.",
    }),
  },
  {
    id: "@microsoft/copilot-sdk",
    category: "agent-runtimes",
    label: "GitHub Copilot runtime",
    summary: "Lets copilot_delegate hand a coding task to the GitHub Copilot agent runtime.",
    withoutIt: "copilot_delegate is unavailable and reports how to install it. Other providers and the Claude/Codex delegates are unaffected.",
    sizeMb: 206,
    docsUrl: "https://www.npmjs.com/package/@microsoft/copilot-sdk",
    spec: DependencySpecSchema.parse({
      kind: "node-package",
      id: "@microsoft/copilot-sdk",
      scope: "managed",
      hint: "Install the Copilot runtime from Settings → Tools → Packages.",
    }),
  },
];

export function listOptionalPackages(
  category?: OptionalPackageCategory,
): readonly OptionalPackageEntry[] {
  return category ? OPTIONAL_PACKAGES.filter((entry) => entry.category === category) : OPTIONAL_PACKAGES;
}

export function findOptionalPackage(id: string): OptionalPackageEntry | null {
  return OPTIONAL_PACKAGES.find((entry) => entry.id === id) ?? null;
}

export function optionalPackageTarget(id: string): string {
  return `runtime:${id}`;
}
