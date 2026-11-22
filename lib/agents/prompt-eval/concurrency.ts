/**
 * Bounded concurrency for the live prompt-evaluation tier.
 *
 * The suite spends almost all its wall time waiting on provider round trips:
 * each scenario needs a multi-round turn plus judge samples, and a full run is
 * dozens of sequential calls. Running a few scenarios at a time keeps the
 * provider within ordinary rate limits while turning the run's wall time into
 * roughly one third of the sum.
 */

/** Default fan-out: enough to collapse the wait, low enough for provider rate limits. */
export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 6;

/** Reads the operator override and clamps it to a sane fan-out. */
export function resolveConcurrency(raw: string | undefined, fallback = DEFAULT_CONCURRENCY): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_CONCURRENCY);
}

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * Results are delivered to the worker with their catalogue index, so callers
 * that need deterministic ordering can store by index instead of completion
 * order. A rejected worker rejects the whole pool, matching the previous
 * sequential behaviour where one failing scenario failed the test.
 */
export async function mapPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const fanOut = Math.min(Math.max(1, Math.floor(limit)), items.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: fanOut }, run));
}
