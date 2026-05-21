// JSON.parse with a fallback value when the input is malformed (or empty).
// Used everywhere we read responses from external APIs — they're contractually
// JSON but a transient 502 / proxy interstitial occasionally returns HTML.
export function parseJsonSafe<T>(text: string, fallback: T): T;
export function parseJsonSafe<T>(text: string): T | undefined;
export function parseJsonSafe<T>(text: string, fallback?: T): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
