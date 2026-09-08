"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import type {
  LangChainPackageInstallResponse,
  LangChainPackageListResponse,
  LangChainPackageManifestInput,
  LangChainPackageManifestRecord,
  LangChainPackagePendingInstall,
} from "@/api/types";
import type { UnifiedHookResult } from "@/hooks/useListState";

export function usePackages(): UnifiedHookResult<
  {
    loadResult: LangChainPackageListResponse | null;
    manifests: LangChainPackageManifestRecord[];
    pending: LangChainPackagePendingInstall[];
    loading: boolean;
    error: string | null;
  },
  {
    refresh: () => Promise<void>;
    install: (spec: string, version?: string) => Promise<LangChainPackageInstallResponse>;
    remove: (spec: string) => Promise<void>;
    approveInstall: (id: string) => Promise<LangChainPackageInstallResponse>;
    denyInstall: (id: string) => Promise<void>;
    createManifest: (data: LangChainPackageManifestInput) => Promise<void>;
    updateManifest: (name: string, data: Omit<LangChainPackageManifestInput, "name">) => Promise<void>;
    deleteManifest: (name: string) => Promise<void>;
    reload: () => Promise<void>;
    setDefaultEnabled: (id: string, enabled: boolean) => Promise<void>;
    setManifestEnabled: (name: string, enabled: boolean) => Promise<void>;
  }
> {
  const [snapshot, setSnapshot] = useState<{
    loadResult: LangChainPackageListResponse | null;
    manifests: LangChainPackageManifestRecord[];
    pending: LangChainPackagePendingInstall[];
  }>({
    loadResult: null,
    manifests: [],
    pending: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [load, mfs, pend] = await Promise.all([
        api.packages.list(),
        api.packages.listManifests(),
        api.packages.listPending(),
      ]);
      setSnapshot({ loadResult: load, manifests: mfs, pending: pend });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const install = useCallback(async (spec: string, version?: string) => {
    const res = await api.packages.install(spec, version);
    await refresh();
    return res;
  }, [refresh]);

  const remove = useCallback(async (spec: string) => {
    await api.packages.remove(spec);
    await refresh();
  }, [refresh]);

  const approveInstall = useCallback(async (id: string) => {
    const res = await api.packages.approveInstall(id);
    await refresh();
    return res;
  }, [refresh]);

  const denyInstall = useCallback(async (id: string) => {
    await api.packages.denyInstall(id);
    await refresh();
  }, [refresh]);

  const createManifest = useCallback(async (data: LangChainPackageManifestInput) => {
    await api.packages.createManifest(data);
    await refresh();
  }, [refresh]);

  const updateManifest = useCallback(async (
    name: string,
    data: Omit<LangChainPackageManifestInput, "name">,
  ) => {
    await api.packages.updateManifest(name, data);
    await refresh();
  }, [refresh]);

  const deleteManifest = useCallback(async (name: string) => {
    await api.packages.deleteManifest(name);
    await refresh();
  }, [refresh]);

  const reload = useCallback(async () => {
    const loadResult = await api.packages.reload();
    const [manifests, pending] = await Promise.all([
      api.packages.listManifests(),
      api.packages.listPending(),
    ]);
    setSnapshot({ loadResult, manifests, pending });
  }, []);

  const setDefaultEnabled = useCallback(async (id: string, enabled: boolean) => {
    await api.packages.setDefaultEnabled(id, enabled);
    await refresh();
  }, [refresh]);

  const setManifestEnabled = useCallback(async (name: string, enabled: boolean) => {
    await api.packages.setManifestEnabled(name, enabled);
    await refresh();
  }, [refresh]);

  const state = {
    loadResult: snapshot.loadResult,
    manifests: snapshot.manifests,
    pending: snapshot.pending,
    loading,
    error,
  };
  const commands = {
    refresh,
    install,
    remove,
    approveInstall,
    denyInstall,
    createManifest,
    updateManifest,
    deleteManifest,
    reload,
    setDefaultEnabled,
    setManifestEnabled,
  };

  return {
    state,
    commands,
    ...state,
    ...commands,
  };
}
