// Pure sort + filter helpers for dashboard report panels. Extracted from the
// React component so each rule can be table-tested without rendering.

import { detectModelFunctionality } from "./classify";

export type ModelSort =
  | "model_asc"
  | "model_desc"
  | "input_desc"
  | "input_asc"
  | "output_desc"
  | "output_asc"
  | "confidence_desc"
  | "confidence_asc";

export type ToolSort =
  | "best"
  | "calls_desc"
  | "errors_desc"
  | "error_rate_desc"
  | "name_asc";

export type Confidence = "high" | "medium" | "low";

export interface ModelRateRow {
  provider: string;
  model_id: string;
  input_per_1m_usd: number | null;
  output_per_1m_usd: number | null;
  confidence: Confidence;
}

export interface ToolRow {
  name: string;
  call_count: number;
  error_count: number;
  score: number;
  success_rate: number;
}

export interface ModelFilter {
  vendor: string;
  functionality: string;
  search: string;
}

function confidenceRank(c: Confidence): number {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

export function filterModelRates<T extends ModelRateRow>(
  rows: ReadonlyArray<T>,
  filter: ModelFilter,
): T[] {
  const query = (filter.search ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.vendor && filter.vendor !== "all" && row.provider !== filter.vendor) return false;
    if (
      filter.functionality &&
      filter.functionality !== "all" &&
      detectModelFunctionality(row.model_id) !== filter.functionality
    ) {
      return false;
    }
    if (!query) return true;
    return `${row.provider}/${row.model_id}`.toLowerCase().includes(query);
  });
}

export function sortModelRates<T extends ModelRateRow>(
  rows: ReadonlyArray<T>,
  sort: ModelSort,
): T[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (sort === "model_desc") return b.model_id.localeCompare(a.model_id);
    if (sort === "input_desc") return (b.input_per_1m_usd ?? -1) - (a.input_per_1m_usd ?? -1);
    if (sort === "input_asc") {
      return (
        (a.input_per_1m_usd ?? Number.POSITIVE_INFINITY) -
        (b.input_per_1m_usd ?? Number.POSITIVE_INFINITY)
      );
    }
    if (sort === "output_desc") return (b.output_per_1m_usd ?? -1) - (a.output_per_1m_usd ?? -1);
    if (sort === "output_asc") {
      return (
        (a.output_per_1m_usd ?? Number.POSITIVE_INFINITY) -
        (b.output_per_1m_usd ?? Number.POSITIVE_INFINITY)
      );
    }
    if (sort === "confidence_desc") {
      const rankDiff = confidenceRank(b.confidence) - confidenceRank(a.confidence);
      if (rankDiff !== 0) return rankDiff;
    }
    if (sort === "confidence_asc") {
      const rankDiff = confidenceRank(a.confidence) - confidenceRank(b.confidence);
      if (rankDiff !== 0) return rankDiff;
    }
    return a.model_id.localeCompare(b.model_id);
  });
  return copy;
}

export function groupModelRatesByVendor<T extends ModelRateRow>(
  rows: ReadonlyArray<T>,
): Array<[string, T[]]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const arr = grouped.get(row.provider) ?? [];
    arr.push(row);
    grouped.set(row.provider, arr);
  }
  return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function sortTools<T extends ToolRow>(
  rows: ReadonlyArray<T>,
  sort: ToolSort,
): T[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (sort === "calls_desc") {
      if (b.call_count !== a.call_count) return b.call_count - a.call_count;
    } else if (sort === "errors_desc") {
      if (b.error_count !== a.error_count) return b.error_count - a.error_count;
    } else if (sort === "error_rate_desc") {
      const aRate = a.call_count > 0 ? a.error_count / a.call_count : 0;
      const bRate = b.call_count > 0 ? b.error_count / b.call_count : 0;
      if (bRate !== aRate) return bRate - aRate;
    } else if (sort === "name_asc") {
      return a.name.localeCompare(b.name);
    } else {
      if (b.score !== a.score) return b.score - a.score;
      if (b.success_rate !== a.success_rate) return b.success_rate - a.success_rate;
      if (b.call_count !== a.call_count) return b.call_count - a.call_count;
    }
    return a.name.localeCompare(b.name);
  });
  return copy;
}
