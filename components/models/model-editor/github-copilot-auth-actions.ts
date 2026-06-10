import { api } from "@/api/client";
import type { DeviceFlow, GhCopilotState } from "./useGitHubCopilotAuth";

export type PollResult = "continue" | "slow_down" | "done";

export interface AuthSetters {
  setStatus: (s: GhCopilotState | null) => void;
  setFlow: (f: DeviceFlow | null) => void;
  setPolling: (b: boolean) => void;
  setMessage: (m: string | null) => void;
  setError: (e: string | null) => void;
}

export function makeStartSignIn(setters: AuthSetters) {
  return async function startSignIn() {
    setters.setError(null); setters.setMessage(null);
    try {
      const f = await api.githubCopilotAuth.start();
      const interval = f.interval || 5;
      setters.setFlow({ user_code: f.user_code, verification_uri: f.verification_uri, device_code: f.device_code, interval });
      setters.setPolling(true);
      void pollLoop(setters, f.device_code, interval, f.expires_in || 900);
    } catch (e) { setters.setError(e instanceof Error ? e.message : String(e)); }
  };
}

export function makeSignOut(setters: AuthSetters) {
  return async function signOut() {
    setters.setError(null); setters.setMessage(null);
    try {
      await api.githubCopilotAuth.signOut();
      setters.setStatus(await api.githubCopilotAuth.status());
      setters.setMessage("Signed out.");
    } catch (e) { setters.setError(e instanceof Error ? e.message : String(e)); }
  };
}

async function pollLoop(setters: AuthSetters, deviceCode: string, intervalSec: number, expiresInSec: number) {
  const deadline = Date.now() + expiresInSec * 1000;
  let interval = intervalSec;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const result = await pollOnce(setters, deviceCode);
    if (result === "continue") continue;
    if (result === "slow_down") { interval += 5; continue; }
    return;
  }
  setters.setError("Sign-in timed out. Try again.");
  setters.setFlow(null); setters.setPolling(false);
}

async function pollOnce(setters: AuthSetters, deviceCode: string): Promise<PollResult> {
  try {
    const res = await api.githubCopilotAuth.poll(deviceCode);
    if (res.status === "success") {
      setters.setMessage("Signed in to GitHub Copilot.");
      setters.setFlow(null); setters.setPolling(false);
      setters.setStatus(await api.githubCopilotAuth.status());
      return "done";
    }
    if (res.status === "slow_down") return "slow_down";
    if (res.status === "pending") return "continue";
    setters.setError(`Sign-in failed: ${res.status}${res.error ? ` (${res.error})` : ""}`);
    setters.setFlow(null); setters.setPolling(false);
    return "done";
  } catch (e) {
    setters.setError(e instanceof Error ? e.message : String(e));
    setters.setPolling(false);
    return "done";
  }
}
