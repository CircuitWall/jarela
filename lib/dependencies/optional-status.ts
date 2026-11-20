/**
 * Optional-package status, grouped by category, for the UI and the API.
 *
 * `optional-catalog.ts` stays pure data; this module adds live probe state so
 * a user can see, per category, what is installed, what it would cost, and
 * what still works without it.
 */
import { probeDependencies } from "./probe";
import {
  OPTIONAL_PACKAGES,
  OPTIONAL_PACKAGE_CATEGORIES,
  OPTIONAL_PACKAGE_CATEGORY_LABELS,
  optionalPackageTarget,
  type OptionalPackageCategory,
} from "./optional-catalog";
import type { DependencyState } from "./schema";

export interface OptionalPackageStatus {
  id: string;
  category: OptionalPackageCategory;
  label: string;
  summary: string;
  withoutIt: string;
  sizeMb: number;
  docsUrl: string | null;
  /** `runtime:<package>` — the value accepted by the install endpoint. */
  target: string;
  state: DependencyState;
  installable: boolean;
  detail: string | null;
  hint: string | null;
}

export interface OptionalPackageCategoryGroup {
  id: OptionalPackageCategory;
  label: string;
  /** Sum of the not-yet-installed sizes in this category. */
  pendingSizeMb: number;
  packages: OptionalPackageStatus[];
}

export async function listOptionalPackageStatuses(
  options: { force?: boolean; category?: OptionalPackageCategory } = {},
): Promise<OptionalPackageStatus[]> {
  const entries = options.category
    ? OPTIONAL_PACKAGES.filter((entry) => entry.category === options.category)
    : OPTIONAL_PACKAGES;
  const statuses = await probeDependencies(entries.map((entry) => entry.spec), { force: options.force });

  return entries.map((entry, index) => {
    const status = statuses[index];
    return {
      id: entry.id,
      category: entry.category,
      label: entry.label,
      summary: entry.summary,
      withoutIt: entry.withoutIt,
      sizeMb: entry.sizeMb,
      docsUrl: entry.docsUrl ?? null,
      target: optionalPackageTarget(entry.id),
      state: status?.state ?? "unverified",
      installable: status?.installable ?? true,
      detail: status?.detail ?? null,
      hint: status?.hint ?? null,
    };
  });
}

/** Group statuses into the category order the catalogue declares. */
export function groupOptionalPackages(
  statuses: readonly OptionalPackageStatus[],
): OptionalPackageCategoryGroup[] {
  return OPTIONAL_PACKAGE_CATEGORIES.map((category) => {
    const packages = statuses.filter((status) => status.category === category);
    return {
      id: category,
      label: OPTIONAL_PACKAGE_CATEGORY_LABELS[category],
      pendingSizeMb: packages
        .filter((status) => status.state !== "satisfied")
        .reduce((sum, status) => sum + status.sizeMb, 0),
      packages,
    };
  }).filter((group) => group.packages.length > 0);
}
