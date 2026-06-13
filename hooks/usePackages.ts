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

export interface UsePackagesResult {
  loadResult: LangChainPackageListResponse | null;
  manifests: LangChainPackageManifestRecord[];
  pending: LangChainPackagePendingInstall[];
  loading: boolean;
  refresh: () => Promise<void>;
  install: (spec: string, version?: string) => Promise<LangChainPackageInstallResponse>;
  approveInstall: (id: string) => Promise<LangChainPackageInstallResponse>;
  denyInstall: (id: string) => Promise<void>;
  createManifest: (data: LangChainPackageManifestInput) => Promise<void>;
  updateManifest: (
    name: string,
    data: Omit<LangChainPackageManifestInput, "name">,
  ) => Promise<void>;
  deleteManifest: (name: string) => Promise<void>;
  reload: () => Promise<void>;
}

export function usePackages(): UsePackagesResult {
  const [loadResult, setLoadResult] = useState<LangChainPackageListResponse | null>(null);
  const [manifests, setManifests] = useState<LangChainPackageManifestRecord[]>([]);
  const [pending, setPending] = useState<LangChainPackagePendingInstall[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [load, mfs, pend] = await Promise.all([
        api.packages.list(),
        api.packages.listManifests(),
        api.packages.listPending(),
      ]);
      setLoadResult(load);
      setManifests(mfs);
      setPending(pend);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = useCallback(async (spec: string, version?: string) => {
    const res = await api.packages.install(spec, version);
    await refresh();
    return res;
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
    const res = await api.packages.reload();
    setLoadResult(res);
  }, []);

  return {
    loadResult,
    manifests,
    pending,
    loading,
    refresh,
    install,
    approveInstall,
    denyInstall,
    createManifest,
    updateManifest,
    deleteManifest,
    reload,
  };
}
