import { request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { verifyE2EIsolation } from "../../scripts/e2e-isolation.mjs";
import { resolveE2EServers } from "../../scripts/e2e-servers.mjs";

export default async function verifyServerIsolation(): Promise<void> {
  const { urls } = resolveE2EServers(process.env);
  if (urls.length < 2) return;

  await verifyE2EIsolation(urls, (baseURL) => request.newContext({ baseURL }), `e2e-isolation-${randomUUID()}`);
}
