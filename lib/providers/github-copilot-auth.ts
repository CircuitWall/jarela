// GitHub Copilot device-flow login. Lets users sign in with their Copilot
// subscription instead of pasting a PAT (which can't be exchanged for a
// Copilot session token and gets rate-limited on the Models REST API).
//
// Flow (RFC 8628):
//   1. POST github.com/login/device/code with the VS Code Copilot client_id.
//   2. Show the user_code + verification_uri so the user can approve.
//   3. Poll github.com/login/oauth/access_token until success/expiry.
//   4. Persist the resulting OAuth access token (gho_...) in memory_store.
//   5. At request time, exchange that OAuth token for a Copilot session token
//      via api.github.com/copilot_internal/v2/token (already implemented in
//      github-copilot.ts).

import { getMemory, putMemory, deleteMemory } from "@/lib/stores/memory";

// Public client ID used by the official VS Code GitHub Copilot extension.
// Same value is hard-coded into many open-source Copilot clients.
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const SCOPE = "read:user";

const NAMESPACE = "github-copilot-auth";
const KEY_OAUTH = "oauth_token";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface PollResult {
  status: "pending" | "success" | "slow_down" | "expired" | "denied" | "error";
  access_token?: string;
  error?: string;
}

export async function startDeviceFlow(): Promise<DeviceCodeResponse> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "LangGUI/1.0",
    },
    body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: SCOPE }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub device code request failed (${res.status}): ${body}`);
  }
  const json = await res.json() as DeviceCodeResponse;
  if (!json.device_code || !json.user_code) {
    throw new Error("GitHub device code response missing required fields");
  }
  return json;
}

export async function pollDeviceFlow(device_code: string): Promise<PollResult> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "LangGUI/1.0",
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  if (!res.ok) {
    return { status: "error", error: `HTTP ${res.status}` };
  }
  const json = await res.json() as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (json.access_token) {
    storeOAuthToken(json.access_token);
    return { status: "success", access_token: json.access_token };
  }
  switch (json.error) {
    case "authorization_pending": return { status: "pending" };
    case "slow_down": return { status: "slow_down" };
    case "expired_token": return { status: "expired" };
    case "access_denied": return { status: "denied" };
    default: return { status: "error", error: json.error_description || json.error || "unknown" };
  }
}

export function storeOAuthToken(token: string): void {
  putMemory(NAMESPACE, KEY_OAUTH, { token, stored_at: new Date().toISOString() });
}

export function getStoredOAuthToken(): string | null {
  const row = getMemory(NAMESPACE, KEY_OAUTH);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { token?: string };
    return parsed.token ?? null;
  } catch {
    return null;
  }
}

export function clearStoredOAuthToken(): boolean {
  return deleteMemory(NAMESPACE, KEY_OAUTH);
}

export function getAuthStatus(): { signed_in: boolean; stored_at: string | null } {
  const row = getMemory(NAMESPACE, KEY_OAUTH);
  if (!row) return { signed_in: false, stored_at: null };
  try {
    const parsed = JSON.parse(row.value) as { stored_at?: string };
    return { signed_in: true, stored_at: parsed.stored_at ?? row.updated_at };
  } catch {
    return { signed_in: true, stored_at: row.updated_at };
  }
}
