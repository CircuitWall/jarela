"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { errorMessage } from "@/lib/utils/error";
import { isMaskedSecret } from "@/lib/utils/secret-mask";
import { sanitizeOAuthInput } from "@/lib/utils/oauth-input";
import type { CredentialEditorMode } from "@/hooks/useIntegrationCredential";

type OAuthProvider = "gmail" | "outlook";

interface OAuthSession {
  timer?: ReturnType<typeof setInterval>;
}

interface IntegrationOAuthOptions {
  integrationName: string;
  credentialId: string | null;
  editorMode?: CredentialEditorMode["kind"];
  configured?: boolean;
  values: Record<string, string>;
  onChanged: () => void;
  onError: (message: string | null) => void;
  onResult: (result: { ok: boolean; message: string } | null) => void;
}

/** Owns one card's OAuth session; stale requests cannot affect a later session. */
export function useIntegrationOAuth({
  integrationName, credentialId, editorMode, configured, values, onChanged, onError, onResult,
}: IntegrationOAuthOptions) {
  const [connecting, setConnecting] = useState(false);
  const activeRef = useRef<OAuthSession | null>(null);
  const onChangedRef = useRef(onChanged);

  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  useEffect(() => {
    setConnecting(false);
    return () => {
      if (activeRef.current?.timer) clearInterval(activeRef.current.timer);
      activeRef.current = null;
    };
  }, [integrationName, credentialId, editorMode]);

  async function connectOAuth(provider: OAuthProvider) {
    if (activeRef.current) return;
    onError(null);
    onResult(null);
    // Keep pasted zero-width characters and saved mask sentinels off the wire.
    const clientId = sanitizeOAuthInput(values.client_id);
    const clientSecret = sanitizeOAuthInput(values.client_secret);
    // Gmail has a bundled desktop client; Outlook requires a saved or BYO app.
    if (provider === "outlook" && !credentialId && !configured && (!clientId || !clientSecret)) {
      onError("Enter the OAuth client ID and client secret first.");
      return;
    }

    const session: OAuthSession = {};
    activeRef.current = session;
    const isActive = () => activeRef.current === session;
    const finish = () => {
      if (session.timer) clearInterval(session.timer);
      activeRef.current = null;
      setConnecting(false);
    };
    const fail = (message: string) => {
      finish();
      onError(message);
    };
    setConnecting(true);

    try {
      const start = provider === "gmail" ? api.integrations.gmailOauthStart : api.integrations.outlookOauthStart;
      const status = provider === "gmail" ? api.integrations.gmailOauthStatus : api.integrations.outlookOauthStatus;
      const label = provider === "gmail" ? "Gmail" : "Outlook";
      const response = await start({
        client_id: clientId && !isMaskedSecret(clientId) ? clientId : undefined,
        client_secret: clientSecret && !isMaskedSecret(clientSecret) ? clientSecret : undefined,
        credential_id: credentialId ?? undefined,
      });
      if (!isActive()) return;
      const popup = window.open(response.authorize_url, `jarela-${provider}-oauth`, "width=560,height=720");
      if (!popup) {
        fail("Browser blocked the OAuth popup. Allow popups for this site and retry.");
        return;
      }

      const startedAt = Date.now();
      let polling = false;
      session.timer = setInterval(async () => {
        if (!isActive()) return;
        // Check the deadline even while a status request is stuck.
        if (Date.now() - startedAt > 10 * 60_000) {
          fail("Timed out waiting for authorization.");
          return;
        }
        if (polling) return;
        polling = true;
        try {
          const result = await status(response.state);
          if (!isActive()) return;
          if (result.status === "done") {
            finish();
            onResult({ ok: true, message: `Connected to ${label}. Refresh token saved.` });
            try { popup.close(); } catch {
              console.warn("Could not close the OAuth popup; close it manually.");
            }
            try { onChangedRef.current(); } catch (e) {
              onError(errorMessage(e));
            }
          } else if (result.status === "error") {
            fail(result.error ?? "Authorization failed.");
          } else if (result.status === "unknown") {
            fail("Authorization session expired.");
          }
        } catch (e) {
          if (isActive()) fail(errorMessage(e));
        } finally {
          polling = false;
        }
      }, 1500);
    } catch (e) {
      if (isActive()) fail(errorMessage(e));
    }
  }

  const state = { connecting };
  const commands = { connectOAuth };
  return { state, commands, ...state, ...commands };
}
