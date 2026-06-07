"use client";
import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { api } from "@/api/client";
import type { Credential, CredentialType } from "@/api/types";
import { pushErrorToast } from "@/lib/ui/error-report";

interface Props {
  // When defined, opens in edit mode. Otherwise create mode.
  credential?: Credential;
  // Pre-fill on create. Used when the editor is launched from a context
  // that already knows the type+provider (e.g. ModelEditor's "+ New").
  defaults?: {
    type?: CredentialType;
    provider?: string;
  };
  // List of providers to offer in the dropdown. When omitted, the editor
  // falls back to a hard-coded model-provider list.
  providers?: string[];
  // Locks the type field. Used when launched from a typed context (e.g.
  // ModelEditor only ever creates `type=model` credentials).
  lockType?: boolean;
  onSaved: (cred: Credential) => void;
  onClose: () => void;
}

const FALLBACK_PROVIDERS = ["anthropic", "openai", "github-copilot", "deepseek", "gemini", "cohere", "langchain"];
const TYPES: CredentialType[] = ["model", "tts", "integration", "bridge"];

export function CredentialEditor({ credential, defaults, providers, lockType, onSaved, onClose }: Props) {
  const isEdit = !!credential;
  const [type, setType] = useState<CredentialType>(credential?.type ?? defaults?.type ?? "model");
  const [provider, setProvider] = useState<string>(credential?.provider ?? defaults?.provider ?? "anthropic");
  const [authMethod, setAuthMethod] = useState<"api_key" | "oauth">(credential?.auth_method ?? "api_key");
  const [apiKey, setApiKey] = useState<string>(credential?.params.api_key === "***" ? "" : (credential?.params.api_key ?? ""));
  const [baseUrl, setBaseUrl] = useState<string>(credential?.params.base_url ?? "");
  const [extraHeaders, setExtraHeaders] = useState<string>(
    credential?.params.extra_headers ? JSON.stringify(credential.params.extra_headers, null, 2) : "",
  );
  const [clientId, setClientId] = useState<string>(credential?.params.client_id ?? "");
  const [clientSecret, setClientSecret] = useState<string>(credential?.params.client_secret === "***" ? "" : (credential?.params.client_secret ?? ""));
  const [refreshToken, setRefreshToken] = useState<string>(credential?.params.refresh_token === "***" ? "" : (credential?.params.refresh_token ?? ""));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscapeKey(onClose);

  // Refresh the api_key/secret state when switching credentials in the
  // parent (e.g. opening edit-on-another-row without unmounting). React
  // keeps initial useState values when only the prop changes.
  useEffect(() => {
    if (credential) {
      setType(credential.type);
      setProvider(credential.provider);
      setAuthMethod(credential.auth_method);
      setApiKey(credential.params.api_key === "***" ? "" : (credential.params.api_key ?? ""));
      setBaseUrl(credential.params.base_url ?? "");
      setExtraHeaders(credential.params.extra_headers ? JSON.stringify(credential.params.extra_headers, null, 2) : "");
      setClientId(credential.params.client_id ?? "");
      setClientSecret(credential.params.client_secret === "***" ? "" : (credential.params.client_secret ?? ""));
      setRefreshToken(credential.params.refresh_token === "***" ? "" : (credential.params.refresh_token ?? ""));
    }
  }, [credential]);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const params: Record<string, unknown> = {};
      if (authMethod === "api_key") {
        // Empty api_key on edit means "keep existing" — the server's
        // redaction round-trip protocol uses "***" sentinels for that.
        if (apiKey.trim()) params.api_key = apiKey.trim();
        else if (isEdit && credential?.params.api_key === "***") params.api_key = "***";
        if (baseUrl.trim()) params.base_url = baseUrl.trim();
        if (extraHeaders.trim()) {
          try {
            const parsed = JSON.parse(extraHeaders);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            params.extra_headers = parsed;
          } catch {
            setError("Extra headers must be a JSON object");
            setSaving(false);
            return;
          }
        }
      } else {
        if (clientId.trim()) params.client_id = clientId.trim();
        if (clientSecret.trim()) params.client_secret = clientSecret.trim();
        else if (isEdit && credential?.params.client_secret === "***") params.client_secret = "***";
        if (refreshToken.trim()) params.refresh_token = refreshToken.trim();
        else if (isEdit && credential?.params.refresh_token === "***") params.refresh_token = "***";
      }

      const saved = isEdit
        ? await api.credentials.update(credential!.id, { provider, auth_method: authMethod, params })
        : await api.credentials.create({ type, provider, auth_method: authMethod, params });
      onSaved(saved);
      onClose();
    } catch (e) {
      pushErrorToast({
        title: isEdit ? "Couldn't update credential" : "Couldn't create credential",
        error: e,
        context: { panel: "credentials", action: isEdit ? "credential.update" : "credential.create", type, provider },
      });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const providerList = providers ?? FALLBACK_PROVIDERS;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-[70] p-2 sm:p-4 overflow-y-auto">
      <div className="bg-surface-2 border border-border rounded-2xl w-full max-w-md shadow-xl my-2 sm:my-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-fg">{isEdit ? `Edit credential — ${credential!.id}` : "New credential"}</h3>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Type</span>
              <select
                className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                value={type}
                onChange={(e) => setType(e.target.value as CredentialType)}
                disabled={lockType || isEdit}
              >
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Provider</span>
              <select
                className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                disabled={isEdit}
              >
                {providerList.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-xs text-fg-subtle mb-1 block">Auth method</span>
            <select
              className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
              value={authMethod}
              onChange={(e) => setAuthMethod(e.target.value as "api_key" | "oauth")}
            >
              <option value="api_key">API key</option>
              <option value="oauth">OAuth</option>
            </select>
          </label>

          {authMethod === "api_key" ? (
            <>
              <label className="block">
                <span className="text-xs text-fg-subtle mb-1 block">
                  API Key
                  {isEdit && credential?.params.api_key === "***" && (
                    <span className="ml-1 text-fg-faint">(leave blank to keep existing)</span>
                  )}
                </span>
                <input
                  type="password"
                  className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="••••••••"
                />
              </label>
              <label className="block">
                <span className="text-xs text-fg-subtle mb-1 block">Base URL (optional)</span>
                <input
                  className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://custom-endpoint"
                />
              </label>
              <label className="block">
                <span className="text-xs text-fg-subtle mb-1 block">Extra headers (JSON, optional)</span>
                <textarea
                  className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent font-mono h-20 resize-none"
                  value={extraHeaders}
                  onChange={(e) => setExtraHeaders(e.target.value)}
                  placeholder='{"X-Custom": "value"}'
                />
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="text-xs text-fg-subtle mb-1 block">Client ID</span>
                <input
                  className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                  value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="oauth-client-id"
                />
              </label>
              <label className="block">
                <span className="text-xs text-fg-subtle mb-1 block">
                  Client secret
                  {isEdit && credential?.params.client_secret === "***" && (
                    <span className="ml-1 text-fg-faint">(leave blank to keep existing)</span>
                  )}
                </span>
                <input
                  type="password"
                  className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                  value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="••••••••"
                />
              </label>
              <label className="block">
                <span className="text-xs text-fg-subtle mb-1 block">
                  Refresh token
                  {isEdit && credential?.params.refresh_token === "***" && (
                    <span className="ml-1 text-fg-faint">(leave blank to keep existing)</span>
                  )}
                </span>
                <input
                  type="password"
                  className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                  value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="••••••••"
                />
              </label>
              <p className="text-[11px] text-fg-faint leading-relaxed">
                OAuth device-flow and authorization-code flows are still surfaced via their dedicated panels (GitHub Copilot, integrations). This form is for paste-in tokens only.
              </p>
            </>
          )}

          {error && <p className="text-red-700 dark:text-red-400 text-xs">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4 pt-1 border-t border-border/60">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm font-medium bg-accent hover:bg-accent-hover text-white rounded-xl shadow-sm transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            {saving ? "Saving…" : isEdit ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
