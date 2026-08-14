import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { CatalogModel, Credential, IntegrationStatus, ModelConfig } from "@/api/types";
import { integrationNameForProvider } from "@/lib/providers/provider-integration-map";
import type { ProbeResult, ShrinkPending } from "./useModelEditorForm";

const FALLBACK_PROVIDERS = ["anthropic", "openai", "github-copilot", "deepseek", "gemini", "langchain"];

export function useIdentityState(model: ModelConfig | undefined) {
  const isEdit = !!model;
  const [name, setName] = useState(model?.name ?? "");
  const [nameTouched, setNameTouched] = useState(isEdit);
  const [provider, setProvider] = useState(model?.provider ?? "anthropic");
  const [providers, setProviders] = useState<string[]>(FALLBACK_PROVIDERS);
  const [modelId, setModelId] = useState(model?.model_id ?? "");
  useProviderList(setProviders);
  return { isEdit, model, name, setName, nameTouched, setNameTouched, provider, setProvider, providers, modelId, setModelId };
}

export function useCredentialState(
  model: ModelConfig | undefined, provider: string, isEdit: boolean,
) {
  const [credentialId, setCredentialId] = useState<string | null>(model?.credential_id ?? null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const refreshCredentials = useCredentialList(setCredentials);
  const integrationName = integrationNameForProvider(provider);
  const providerCredentials = useMemo(
    () => credentials.filter((c) => c.provider === integrationName),
    [credentials, integrationName],
  );
  // Default to first matching credential on new configs; drop binding when
  // provider switch invalidates the current pick.
  useEffect(() => {
    if (isEdit || credentialId || providerCredentials.length === 0) return;
    setCredentialId(providerCredentials[0].id);
  }, [isEdit, credentialId, providerCredentials]);
  useEffect(() => {
    if (!credentialId) return;
    const stillValid = credentials.some((c) => c.id === credentialId && c.provider === integrationName);
    if (!stillValid) setCredentialId(null);
  }, [integrationName, credentialId, credentials]);
  return {
    credentialId, setCredentialId, credentials, setCredentials,
    credentialDialogOpen, setCredentialDialogOpen,
    integrationName, providerCredentials, refreshCredentials,
  };
}

export function useParamsState(model: ModelConfig | undefined) {
  const [apiKey, setApiKey] = useState(model?.params.api_key === "***" ? "" : (model?.params.api_key ?? ""));
  const [baseUrl, setBaseUrl] = useState(model?.params.base_url ?? "");
  const [extraHeaders, setExtraHeaders] = useState(
    model?.params.extra_headers ? JSON.stringify(model.params.extra_headers, null, 2) : "",
  );
  const [temperature, setTemperature] = useState(String(model?.params.temperature ?? ""));
  const [maxTokens, setMaxTokens] = useState(String(model?.params.max_tokens ?? ""));
  const [contextWindowTokens, setContextWindowTokens] = useState(String(model?.params.context_window_tokens ?? ""));
  const [autoMaxTokens, setAutoMaxTokens] = useState<string | null>(null);
  const [autoContextWindowTokens, setAutoContextWindowTokens] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(model?.is_default ?? false);
  return {
    apiKey, setApiKey, baseUrl, setBaseUrl, extraHeaders, setExtraHeaders,
    temperature, setTemperature, maxTokens, setMaxTokens,
    contextWindowTokens, setContextWindowTokens,
    autoMaxTokens, setAutoMaxTokens, autoContextWindowTokens, setAutoContextWindowTokens,
    isDefault, setIsDefault,
  };
}

export function useStatusState() {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult>(null);
  const [allowSaveAnyway, setAllowSaveAnyway] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [pendingShrinkConfirm, setPendingShrinkConfirm] = useState<ShrinkPending>(null);
  return {
    error, setError, saving, setSaving, probing, setProbing,
    probeResult, setProbeResult, allowSaveAnyway, setAllowSaveAnyway,
    compacting, setCompacting, pendingShrinkConfirm, setPendingShrinkConfirm,
  };
}

export function useCatalogState(provider: string) {
  const [showCatalog, setShowCatalog] = useState(false);
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  // Reset catalog when provider changes — different provider = different list.
  useEffect(() => { setCatalog(null); setCatalogError(null); setShowCatalog(false); }, [provider]);
  return {
    showCatalog, setShowCatalog, catalog, setCatalog,
    catalogLoading, setCatalogLoading, catalogError, setCatalogError,
    catalogSearch, setCatalogSearch,
  };
}

export function useIntegrationsState() {
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  useIntegrationList(setIntegrations);
  return { integrations };
}

function useProviderList(setProviders: (v: string[]) => void) {
  const run = useCallback(async () => {
    const names = await api.models.providers();
    if (Array.isArray(names) && names.length > 0) setProviders(names);
  }, [setProviders]);

  useRefreshableLoad(
    run,
  );
}

function useIntegrationList(setIntegrations: (v: IntegrationStatus[]) => void) {
  const run = useCallback(async () => {
    const res = await api.integrations.list();
    setIntegrations(res.statuses);
  }, [setIntegrations]);

  const handleError = useCallback(() => {
    setIntegrations([]);
  }, [setIntegrations]);

  useRefreshableLoad(
    run,
    handleError,
  );
}

function useCredentialList(setCredentials: (v: Credential[]) => void) {
  const run = useCallback(async () => {
    setCredentials(await api.credentials.list({ type: "integration" }));
  }, [setCredentials]);

  const handleError = useCallback(() => {
    setCredentials([]);
  }, [setCredentials]);

  const refresh = useRefreshableLoad(
    run,
    handleError,
    "jarela:credentials-changed",
  );
  return refresh;
}

function useRefreshableLoad(
  run: () => Promise<void>,
  onError?: () => void,
  eventName?: string,
) {
  const refresh = useCallback(async () => {
    try {
      await run();
    } catch {
      onError?.();
    }
  }, [run, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!eventName || typeof window === "undefined") return;
    const onChange = () => { void refresh(); };
    window.addEventListener(eventName, onChange);
    return () => window.removeEventListener(eventName, onChange);
  }, [eventName, refresh]);

  return refresh;
}
