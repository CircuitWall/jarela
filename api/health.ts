import { runtimeConfig } from "./runtime-config";

export const SERVER_ACTIVITY_EVENT = "jarela:server-activity";

export interface HealthDetails {
  agents: string[];
  crypto: { source: string };
  db_path?: string;
}

let inFlight: Promise<HealthDetails> | null = null;

export function reportServerActivity(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SERVER_ACTIVITY_EVENT));
  }
}

function parseHealthDetails(value: unknown): HealthDetails {
  if (!value || typeof value !== "object"
    || !("status" in value) || value.status !== "ok"
    || !("agents" in value) || !Array.isArray(value.agents)
    || !value.agents.every((agent) => typeof agent === "string")
    || !("crypto" in value) || !value.crypto || typeof value.crypto !== "object"
    || !("source" in value.crypto) || typeof value.crypto.source !== "string") {
    throw new Error("Runtime diagnostics response was invalid");
  }
  const details: HealthDetails = {
    agents: value.agents,
    crypto: { source: value.crypto.source },
  };
  if ("db_path" in value) {
    if (typeof value.db_path !== "string") {
      throw new Error("Runtime diagnostics response was invalid");
    }
    details.db_path = value.db_path;
  }
  return details;
}

export function fetchHealthDetails(): Promise<HealthDetails> {
  if (inFlight) return inFlight;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtimeConfig().healthCheckTimeoutMs);
  const request = fetch("/api/v1/health", { cache: "no-store", signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error("Runtime diagnostics request failed");
      return parseHealthDetails(await response.json());
    })
    .finally(() => {
      clearTimeout(timeout);
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
  return request;
}
