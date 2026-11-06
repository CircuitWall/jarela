/**
 * Verify each server sees only its own probe, then remove every probe.
 * @param {string[]} urls
 * @param {(url: string) => Promise<import("@playwright/test").APIRequestContext>} createContext
 * @param {string} namespace
 */
export async function verifyE2EIsolation(urls, createContext, namespace) {
  if (urls.length < 2) return;

  /** @type {import("@playwright/test").APIRequestContext[]} */
  const contexts = [];
  /** @type {{ index: number, id: string }[]} */
  const written = [];
  let failure;
  let failed = false;
  try {
    for (const url of urls) contexts.push(await createContext(url));
    for (const [index, context] of contexts.entries()) {
      const name = `${namespace}-${index}`;
      const response = await context.post("/api/v1/harnesses", {
        data: { name },
      });
      if (!response.ok()) throw new Error(`E2E isolation probe write failed on worker ${index}: ${response.status()}`);
      const body = await response.json();
      if (typeof body?.id !== "string" || !body.id || body.name !== name) {
        throw new Error(`E2E isolation probe returned an invalid harness on worker ${index}`);
      }
      written.push({ index, id: body.id });
    }
    for (const { index, id } of written) {
      for (const [target, context] of contexts.entries()) {
        const response = await context.get(`/api/v1/harnesses/${encodeURIComponent(id)}`);
        if (target === index) {
          if (!response.ok()) throw new Error(`E2E isolation probe read failed on worker ${target}: ${response.status()}`);
          const body = await response.json();
          if (body?.id !== id || body.name !== `${namespace}-${index}`) {
            throw new Error(`E2E isolation probe returned incorrect data on worker ${target}`);
          }
        } else if (response.status() !== 404) {
          if (response.ok()) throw new Error(`E2E servers ${index} and ${target} do not have isolated storage`);
          throw new Error(`E2E isolation probe read failed on worker ${target}: ${response.status()}`);
        }
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(`E2E isolation probe failed: ${String(error)}`, { cause: error });
    failed = true;
  }

  const cleanupErrors = [];
  for (const { index, id } of written) {
    try {
      const response = await contexts[index].delete(`/api/v1/harnesses/${encodeURIComponent(id)}`);
      if (!response.ok()) cleanupErrors.push(new Error(`E2E isolation probe cleanup failed on worker ${index}: ${response.status()}`));
    } catch (error) {
      cleanupErrors.push(new Error(`E2E isolation probe cleanup failed on worker ${index}`, { cause: error }));
    }
  }
  const disposals = await Promise.allSettled(contexts.map((context) => context.dispose()));
  for (const result of disposals) {
    if (result.status === "rejected") cleanupErrors.push(new Error("E2E isolation probe context disposal failed", { cause: result.reason }));
  }
  if (failed && cleanupErrors.length === 0) throw failure;
  if (cleanupErrors.length) {
    const errors = [...(failed ? [failure] : []), ...cleanupErrors];
    throw new AggregateError(errors, `E2E isolation verification failed: ${errors.map(String).join("; ")}`);
  }
}
