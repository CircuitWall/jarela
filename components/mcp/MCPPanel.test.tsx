// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  api: {
    mcp: {
      list: vi.fn(),
      registry: vi.fn(),
      importManifest: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  refresh: vi.fn(),
}));

vi.mock("@/api/client", () => ({ api: mocks.api }));
vi.mock("@/hooks/useListState", () => ({
  useListState: () => ({ items: [], loading: false, refresh: mocks.refresh }),
}));
vi.mock("@/hooks/useDeepLinkScroll", () => ({ useDeepLinkScroll: vi.fn() }));
vi.mock("@/hooks/useDismissGuard", () => ({
  useDirty: () => true,
  useDismissGuard: (options: { onClose: () => void }) => options.onClose,
}));
vi.mock("@/lib/ui/error-report", () => ({ pushErrorToast: vi.fn() }));
vi.mock("@/lib/ui/toasts", () => ({ pushToast: vi.fn() }));

import { MCPPanel } from "./MCPPanel";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mcp.registry.mockResolvedValue({ entries: [], nextCursor: undefined });
  mocks.api.mcp.importManifest.mockResolvedValue({ entry: {} });
  mocks.api.mcp.create.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP custom environment variables", () => {
  it("saves a masked custom env value without losing the stdio command or args", async () => {
    render(<MCPPanel />);

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: /set up a custom server/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "custom-server" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));

    fireEvent.change(screen.getByLabelText("Environment variable name"), { target: { value: "API_TOKEN" } });
    const valueInput = screen.getByLabelText("API_TOKEN value");
    expect(valueInput).toHaveProperty("type", "password");
    fireEvent.change(valueInput, { target: { value: "test-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.api.mcp.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "custom-server",
      transport: "stdio",
      enabled: true,
      spec: expect.objectContaining({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { API_TOKEN: "test-secret" },
      }),
    })));
  });

  it("imports pasted server.json and saves the translated MCP spec", async () => {
    mocks.api.mcp.importManifest.mockResolvedValue({
      entry: {
        id: "weather",
        name: "Weather",
        description: "Weather server",
        category: "Data",
        source: "Vendor",
        transport: "stdio",
        spec: { command: "npx", args: ["-y", "@example/weather"], env: { API_TOKEN: "${API_TOKEN}" } },
        variables: [{ key: "API_TOKEN", label: "API token", secret: true, required: true }],
      },
    });
    render(<MCPPanel />);

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: /set up a custom server/i }));
    fireEvent.change(screen.getByLabelText(/Paste an MCP Registry/), {
      target: { value: '{"name":"io.example/weather","packages":[]}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import server.json" }));

    const tokenInput = await screen.findByLabelText("API token");
    expect(tokenInput).toHaveProperty("type", "password");
    fireEvent.change(tokenInput, { target: { value: "test-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.api.mcp.importManifest).toHaveBeenCalledWith('{"name":"io.example/weather","packages":[]}'));
    await waitFor(() => expect(mocks.api.mcp.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "weather",
      transport: "stdio",
      enabled: false,
      spec: expect.objectContaining({ env: { API_TOKEN: "test-token" } }),
    })));
  });
});