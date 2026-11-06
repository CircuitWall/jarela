import { test as base, expect, request, type APIRequestContext } from "@playwright/test";
import { resolveE2EServers, serverForWorker } from "../../scripts/e2e-servers.mjs";

const { urls } = resolveE2EServers(process.env);

export const test = base.extend<object, { workerRequest: APIRequestContext }>({
  baseURL: async ({}, runWithURL, testInfo) => {
    await runWithURL(serverForWorker(urls, testInfo.parallelIndex));
  },
  workerRequest: [async ({}, runWithRequest, workerInfo) => {
    const context = await request.newContext({ baseURL: serverForWorker(urls, workerInfo.parallelIndex) });
    try {
      await runWithRequest(context);
    } finally {
      await context.dispose();
    }
  }, { scope: "worker" }],
});

export { expect };
