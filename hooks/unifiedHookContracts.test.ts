// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgents } from "@/hooks/useAgents";
import { useTools } from "@/hooks/useTools";
import { usePackages } from "@/hooks/usePackages";

const agentsListMock = vi.fn();
const agentsCreateMock = vi.fn();
const agentsUpdateMock = vi.fn();
const agentsDeleteMock = vi.fn();

const toolsListMock = vi.fn();

const packagesListMock = vi.fn();
const packagesListManifestsMock = vi.fn();
const packagesListPendingMock = vi.fn();
const packagesInstallMock = vi.fn();
const packagesApproveInstallMock = vi.fn();
const packagesDenyInstallMock = vi.fn();
const packagesCreateManifestMock = vi.fn();
const packagesUpdateManifestMock = vi.fn();
const packagesDeleteManifestMock = vi.fn();
const packagesReloadMock = vi.fn();
const packagesSetDefaultEnabledMock = vi.fn();
const packagesSetManifestEnabledMock = vi.fn();

vi.mock("@/api/client", () => ({
  api: {
    agents: {
      list: (...args: unknown[]) => agentsListMock(...args),
      create: (...args: unknown[]) => agentsCreateMock(...args),
      update: (...args: unknown[]) => agentsUpdateMock(...args),
      delete: (...args: unknown[]) => agentsDeleteMock(...args),
    },
    tools: {
      list: (...args: unknown[]) => toolsListMock(...args),
    },
    packages: {
      list: (...args: unknown[]) => packagesListMock(...args),
      listManifests: (...args: unknown[]) => packagesListManifestsMock(...args),
      listPending: (...args: unknown[]) => packagesListPendingMock(...args),
      install: (...args: unknown[]) => packagesInstallMock(...args),
      approveInstall: (...args: unknown[]) => packagesApproveInstallMock(...args),
      denyInstall: (...args: unknown[]) => packagesDenyInstallMock(...args),
      createManifest: (...args: unknown[]) => packagesCreateManifestMock(...args),
      updateManifest: (...args: unknown[]) => packagesUpdateManifestMock(...args),
      deleteManifest: (...args: unknown[]) => packagesDeleteManifestMock(...args),
      reload: (...args: unknown[]) => packagesReloadMock(...args),
      setDefaultEnabled: (...args: unknown[]) => packagesSetDefaultEnabledMock(...args),
      setManifestEnabled: (...args: unknown[]) => packagesSetManifestEnabledMock(...args),
    },
  },
}));

describe("unified hook contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    agentsListMock.mockResolvedValue([]);
    agentsCreateMock.mockResolvedValue({ id: "a2" });
    agentsUpdateMock.mockResolvedValue({ id: "a1" });
    agentsDeleteMock.mockResolvedValue({ deleted: true });

    toolsListMock.mockImplementation((opts?: { force?: boolean }) =>
      Promise.resolve(opts?.force ? [{ name: "forced" }] : [{ name: "normal" }]),
    );

    packagesListMock.mockResolvedValue({ defaults: [] });
    packagesListManifestsMock.mockResolvedValue([]);
    packagesListPendingMock.mockResolvedValue([]);
    packagesInstallMock.mockResolvedValue({ status: "installed", tools: [], resolvedPackage: "x", installedVersion: "1.0.0" });
    packagesApproveInstallMock.mockResolvedValue({ status: "installed", tools: [], resolvedPackage: "x", installedVersion: "1.0.0" });
    packagesDenyInstallMock.mockResolvedValue(undefined);
    packagesCreateManifestMock.mockResolvedValue(undefined);
    packagesUpdateManifestMock.mockResolvedValue(undefined);
    packagesDeleteManifestMock.mockResolvedValue(undefined);
    packagesReloadMock.mockResolvedValue({ defaults: [{ id: "d1" }] });
    packagesSetDefaultEnabledMock.mockResolvedValue(undefined);
    packagesSetManifestEnabledMock.mockResolvedValue(undefined);
  });

  it("useAgents exposes both unified and compatibility surfaces", async () => {
    agentsListMock.mockResolvedValue([{ id: "a1" }]);

    const { result } = renderHook(() => useAgents());

    await waitFor(() => expect(result.current.state.agents).toEqual([{ id: "a1" }]));
    expect(result.current.agents).toEqual(result.current.state.agents);
    expect(result.current.refresh).toBe(result.current.commands.refresh);
  });

  it("useTools force-refreshes via event loader on tools-changed", async () => {
    const { result } = renderHook(() => useTools());

    await waitFor(() => expect(result.current.tools).toEqual([{ name: "normal" }]));

    await act(async () => {
      window.dispatchEvent(new CustomEvent("jarela:tools-changed"));
    });

    await waitFor(() => expect(result.current.state.tools).toEqual([{ name: "forced" }]));
    expect(toolsListMock).toHaveBeenNthCalledWith(1, { includeDisabled: true });
    expect(toolsListMock).toHaveBeenNthCalledWith(2, { force: true, includeDisabled: true });
  });

  it("usePackages exposes state/commands and keeps flat compatibility fields", async () => {
    const { result } = renderHook(() => usePackages());

    await waitFor(() => expect(result.current.state.loading).toBe(false));
    expect(result.current.loadResult).toEqual(result.current.state.loadResult);
    expect(result.current.refresh).toBe(result.current.commands.refresh);

    await act(async () => {
      await result.current.commands.reload();
    });

    expect(result.current.state.loadResult).toEqual({ defaults: [{ id: "d1" }] });
    expect(result.current.loadResult).toEqual({ defaults: [{ id: "d1" }] });
  });
});
