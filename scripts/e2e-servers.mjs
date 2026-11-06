/**
 * Resolve the server assigned to each Playwright worker slot.
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveE2EServers(env) {
  const single = env.JARELA_E2E_BASE_URL;
  const multiple = env.JARELA_E2E_BASE_URLS;
  if (single && multiple) {
    throw new Error("Set only one of JARELA_E2E_BASE_URL and JARELA_E2E_BASE_URLS");
  }

  const external = Boolean(single || multiple);
  const urls = external ? (multiple ?? single).split(",").map((url) => {
    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new Error(`Invalid E2E server URL: ${url}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error(`E2E server URL must be an HTTP(S) origin: ${url}`);
    }
    return parsed.origin;
  }) : [];

  if (new Set(urls).size !== urls.length) {
    throw new Error("Each E2E worker must have a distinct server URL");
  }

  const rawWorkers = env.JARELA_E2E_WORKERS ?? String(external ? urls.length : 2);
  if (!/^[1-9]\d*$/.test(rawWorkers)) {
    throw new Error("JARELA_E2E_WORKERS must be a positive integer");
  }
  const workers = Number(rawWorkers);
  if (!Number.isSafeInteger(workers) || workers > 32) {
    throw new Error("JARELA_E2E_WORKERS must be between 1 and 32");
  }
  if (external && workers > urls.length) {
    throw new Error("JARELA_E2E_WORKERS exceeds the number of E2E server URLs");
  }

  if (!external) {
    const rawPort = env.JARELA_E2E_PORT ?? "14312";
    if (!/^[1-9]\d*$/.test(rawPort)) {
      throw new Error("JARELA_E2E_PORT must be a valid TCP port");
    }
    const port = Number(rawPort);
    if (!Number.isSafeInteger(port) || port + workers - 1 > 65535) {
      throw new Error("E2E server ports must be between 1 and 65535");
    }
    for (let index = 0; index < workers; index++) {
      urls.push(`http://127.0.0.1:${port + index}`);
    }
  }
  return { external, urls: urls.slice(0, workers), workers };
}

/**
 * @param {string[]} urls
 * @param {number} parallelIndex
 */
export function serverForWorker(urls, parallelIndex) {
  const url = urls[parallelIndex];
  if (!url) {
    throw new Error(
      `No isolated E2E server for worker ${parallelIndex}; do not increase --workers beyond the configured servers`,
    );
  }
  return url;
}
