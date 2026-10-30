// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { UnifiedPackageList } from "./UnifiedPackageList";

const mocks = vi.hoisted(() => ({
  saveSecrets: vi.fn(),
  saveConfig: vi.fn(),
  listExtensions: vi.fn(),
  setEnabled: vi.fn(),
  errorToast: vi.fn(),
}));

vi.mock("@/contexts/AppContext", () => ({ useAppContext: () => ({ dispatch: vi.fn() }) }));
vi.mock("@/hooks/usePackages", () => ({
  usePackages: () => ({
    manifests: [],
    loadResult: null,
    refresh: vi.fn(),
    setDefaultEnabled: vi.fn(),
    setManifestEnabled: vi.fn(),
    deleteManifest: vi.fn(),
  }),
}));
vi.mock("@/api/client", () => ({
  api: {
    builtinTools: { list: async () => [], setEnabled: vi.fn() },
    extensions: {
      list: mocks.listExtensions,
      saveToolSecrets: mocks.saveSecrets,
      saveToolConfig: mocks.saveConfig,
      setDropinEnabled: mocks.setEnabled,
    },
  },
}));
vi.mock("@/lib/ui/error-report", () => ({ pushErrorToast: mocks.errorToast }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listExtensions.mockResolvedValue({
    directories: { tools: "tools" },
    errors: [],
    tools: [{
      name: "example_tool",
      description: "Example",
      enabled: true,
      secrets: [
        { key: "stored", label: "Stored key", is_set: true },
        { key: "replacement", label: "Replacement key", is_set: true },
      ],
      config: [{ key: "endpoint", label: "Endpoint", type: "string", value: "local" }],
    }],
  });
});

it("omits masked secrets while preserving explicit clears and separate configuration writes", async () => {
  render(<UnifiedPackageList />);
  fireEvent.click(await screen.findByRole("button", { name: "Expand", exact: true }));
  const replacement = await screen.findByLabelText("Replacement key");
  fireEvent.change(replacement, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));

  await waitFor(() => expect(mocks.saveSecrets).toHaveBeenCalledWith("example_tool", { replacement: "" }));
  await screen.findByText("Credentials saved.");
  expect(mocks.saveConfig).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "changed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await waitFor(() => expect(mocks.saveConfig).toHaveBeenCalledWith("example_tool", { endpoint: "changed" }));
});

it("clears busy state after a failed toggle and retains its typed error context", async () => {
  mocks.setEnabled.mockRejectedValueOnce(new Error("Unavailable"));
  render(<UnifiedPackageList />);
  const enabled = await screen.findByRole("checkbox", { name: "enabled" });
  fireEvent.click(enabled);
  await waitFor(() => expect(mocks.errorToast).toHaveBeenCalledWith({
    title: "Couldn't toggle tool",
    error: expect.any(Error),
    context: {
      panel: "packages",
      action: "toggle-dropin",
      name: "example_tool",
      target_enabled: false,
    },
  }));
  expect((enabled as HTMLInputElement).disabled).toBe(false);
  expect((enabled as HTMLInputElement).checked).toBe(true);

  fireEvent.click(enabled);
  await waitFor(() => expect((enabled as HTMLInputElement).checked).toBe(false));
});
