/**
 * Time-formatting helpers shared by UI components.
 *
 * The codebase had three near-identical "X ago" implementations across
 * BridgeEditor, ScheduledTasksPanel, and ProfileEditor. They all reduce to:
 * convert a timestamp to a delta, pick a unit, label it.
 *
 * Conventions:
 *   - Past timestamps are suffixed " ago" (unless `signed` is false).
 *   - Future timestamps are prefixed "in ".
 *   - Unit thresholds: <60s → "Ns", <60m → "Nm", <48h → "Nh", else "Nd".
 *   - For deltas older than ~7 days, callers that prefer an absolute date
 *     should use `formatRelativeOrDate()`.
 */

export type TimeInput = number | string | Date;

function toMs(input: TimeInput): number {
  if (typeof input === "number") return input;
  if (input instanceof Date) return input.getTime();
  return Date.parse(input);
}

interface Options {
  /** Append " ago" / prefix "in " for past / future. Default true. */
  signed?: boolean;
  /** Use "<1m" rather than "Ns" for sub-minute deltas. Default false. */
  collapseSeconds?: boolean;
}

/**
 * Format a timestamp as a relative "X ago" / "in X" string.
 */
export function formatRelative(input: TimeInput, opts: Options = {}): string {
  const { signed = true, collapseSeconds = false } = opts;
  const ms = toMs(input);
  const delta = ms - Date.now();
  const past = delta <= 0;
  const abs = Math.abs(delta);

  let txt: string;
  if (abs < 60_000) {
    txt = collapseSeconds ? "<1m" : `${Math.max(1, Math.round(abs / 1000))}s`;
  } else if (abs < 3_600_000) {
    txt = `${Math.round(abs / 60_000)}m`;
  } else if (abs < 172_800_000) {
    txt = `${Math.round(abs / 3_600_000)}h`;
  } else {
    txt = `${Math.round(abs / 86_400_000)}d`;
  }

  if (!signed) return txt;
  return past ? `${txt} ago` : `in ${txt}`;
}

/**
 * Like `formatRelative`, but falls back to an absolute locale date once the
 * delta exceeds `maxDays` (default 7).
 */
export function formatRelativeOrDate(input: TimeInput, maxDays = 7): string {
  const ms = toMs(input);
  const abs = Math.abs(ms - Date.now());
  if (abs > maxDays * 86_400_000) return new Date(ms).toLocaleDateString();
  return formatRelative(input);
}
