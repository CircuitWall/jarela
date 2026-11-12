export interface ServerTimingMetric {
  name: string;
  durationMs: number;
  description?: string;
}

/** Attach standard Server-Timing details for inspection in browser DevTools. */
export function withServerTiming<T extends Response>(
  response: T,
  metrics: readonly ServerTimingMetric[],
): T {
  const value = metrics
    .filter(({ name, durationMs }) => /^[a-z][a-z0-9_-]*$/i.test(name) && Number.isFinite(durationMs))
    .map(({ name, durationMs, description }) => {
      const descriptionPart = description
        ? `;desc="${description.replace(/[\\"\r\n]/g, " ").slice(0, 80)}"`
        : "";
      return `${name};dur=${Math.max(0, durationMs).toFixed(1)}${descriptionPart}`;
    })
    .join(", ");
  if (value) response.headers.set("Server-Timing", value);
  return response;
}
