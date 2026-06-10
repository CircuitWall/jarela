import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import { makeSignOut, makeStartSignIn } from "./github-copilot-auth-actions";

export interface DeviceFlow {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number;
}

export interface GhCopilotState {
  signed_in: boolean;
  stored_at: string | null;
}

export function useGitHubCopilotAuth() {
  const [status, setStatus] = useState<GhCopilotState | null>(null);
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  const [polling, setPolling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.githubCopilotAuth.status().then(setStatus).catch(() => setStatus({ signed_in: false, stored_at: null }));
  }, []);

  const actions = useMemo(() => {
    const setters = { setStatus, setFlow, setPolling, setMessage, setError };
    return { startSignIn: makeStartSignIn(setters), signOut: makeSignOut(setters) };
  }, []);

  return { status, flow, polling, message, error, ...actions };
}
