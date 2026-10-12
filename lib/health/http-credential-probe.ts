import {
  getIntegrationRaw,
  isValidHttpCredentialProbe,
  type HttpCredentialProbeDefinition,
} from "@/lib/stores/integrations";
import type { HealthResult } from "./probes";

const DEFAULT_TIMEOUT_MS = 15_000;

function configuredCredential(probe: HttpCredentialProbeDefinition, integration: string): string | null {
  try {
    const saved = getIntegrationRaw(integration)?.[probe.credentialField]?.trim();
    if (saved) return saved;
  } catch {
    // Environment credentials remain available when the store is unavailable.
  }
  const envNames = typeof probe.env === "string" ? [probe.env] : probe.env ?? [];
  for (const name of envNames) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function responseSummary(body: unknown, probe: HttpCredentialProbeDefinition): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(probe.responseDetails ?? {})) {
    const value = valueAtPath(body, definition.path);
    if (definition.count && Array.isArray(value)) detail[key] = value.length;
    else if (typeof value === "number" || typeof value === "boolean" || value === null) detail[key] = value;
    else if (typeof value === "string") detail[key] = value.slice(0, 200);
  }
  return detail;
}

export async function runHttpCredentialProbe(
  integration: string,
  probe: HttpCredentialProbeDefinition,
): Promise<HealthResult> {
  if (!isValidHttpCredentialProbe(probe)) {
    return { ok: false, status: "error", error: "Credential probe configuration is invalid." };
  }
  const credential = configuredCredential(probe, integration);
  if (!credential) {
    return { ok: false, status: "unconfigured", error: `Credential not configured for ${integration}.` };
  }

  const url = new URL(probe.endpoint);
  const headers: Record<string, string> = { ...probe.headers };
  if (probe.auth.type === "bearer") {
    headers.Authorization = `Bearer ${credential}`;
  } else if (probe.auth.type === "header") {
    headers[probe.auth.name] = `${probe.auth.prefix ?? ""}${credential}`;
  } else {
    url.searchParams.set(probe.auth.name, credential);
  }

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if ((probe.authFailureStatuses ?? [401, 403]).includes(response.status)) {
      return { ok: false, status: "auth_failed", error: `${integration} rejected the configured credential (${response.status}).` };
    }
    if ((probe.rateLimitStatuses ?? [429]).includes(response.status)) {
      return { ok: false, status: "transient", error: `${integration} rate-limited the credential probe (${response.status}).` };
    }
    if (!response.ok && !(probe.acceptedStatuses ?? []).includes(response.status)) {
      return { ok: false, status: "error", error: `${integration} credential probe returned ${response.status}.` };
    }

    let body: unknown;
    if (probe.successField || probe.responseDetails) {
      try {
        body = await response.json();
      } catch {
        // A 2xx that is not JSON usually means a proxy or captive portal; do not echo parser details.
        if (response.ok) {
          return { ok: false, status: "transient", error: `${integration} returned an unreadable response (${response.status}); expected JSON.` };
        }
        body = undefined;
      }
    }
    if (probe.successField && valueAtPath(body, probe.successField) === false) {
      return { ok: false, status: "error", error: `${integration} could not verify the credential.` };
    }
    return {
      ok: true,
      status: "ok",
      detail: { httpStatus: response.status, ...responseSummary(body, probe) },
    };
  } catch {
    // Do not echo fetch errors: query-auth providers may embed credentials in the URL.
    return { ok: false, status: "transient", error: `${integration} credential probe could not reach its endpoint.` };
  }
}
