const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status);
}

function retryAfterMs(response) {
  const header = response.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Fetch a URL, retrying transient upstream failures (network errors,
 * timeouts, 408/425/429/5xx) with exponential backoff. Non-retryable HTTP
 * errors fail immediately. Returns the successful response body as a Buffer.
 */
export async function fetchBytesWithRetry(url, {
  label = url,
  attempts = 5,
  baseDelayMs = 2_000,
  maxDelayMs = 30_000,
  timeoutMs = 120_000,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (message) => console.warn(message),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let retryDelay = null;
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      response = null;
    }
    if (response) {
      lastError = new Error(`download failed (${response.status}) for ${label}`);
      if (!isRetryableStatus(response.status)) throw lastError;
      retryDelay = retryAfterMs(response);
    }
    if (attempt === attempts) break;
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const delay = Math.min(maxDelayMs, retryDelay ?? backoff);
    log(`[download] ${label}: attempt ${attempt}/${attempts} failed (${lastError.message}); retrying in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
  throw new Error(`${lastError.message} after ${attempts} attempts`, { cause: lastError });
}
