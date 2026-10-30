// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InstallPanel } from "./InstallPanel";

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  createManifest: vi.fn(),
  approveInstall: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock("@/hooks/usePackages", () => ({
  usePackages: () => ({
    pending: [{ id: "request-1", spec: "example-tools", publisher: "example", reason: "Approval required" }],
    manifests: [],
    install: mocks.install,
    createManifest: mocks.createManifest,
    approveInstall: mocks.approveInstall,
    denyInstall: vi.fn(),
    remove: vi.fn(),
    reload: vi.fn(),
    loadResult: null,
  }),
}));

vi.mock("@/api/client", () => ({ api: { packages: { catalog: mocks.catalog } } }));
vi.mock("@/lib/ui/error-report", () => ({ pushErrorToast: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog.mockResolvedValue({
    entries: [{
      id: "example",
      label: "Example tools",
      npmPackage: "example-tools",
      exportName: "ExampleTool",
      category: "Web",
      capability: "read",
      requiredEnv: ["EXAMPLE_KEY"],
    }],
  });
  mocks.install.mockResolvedValue({ status: "pending", publisher: "example" });
});

function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: /Install package/ }));
}

describe("package installation responsibilities", () => {
  it("keeps the catalog, install input and manifest draft coordinated across collapse", async () => {
    render(<InstallPanel />);
    openPanel();
    fireEvent.change(await screen.findByLabelText("Curated LangChain tool catalog"), {
      target: { value: "example" },
    });
    expect((screen.getByLabelText("Package spec") as HTMLInputElement).value).toBe("example-tools");
    expect((screen.getByLabelText("Manifest name") as HTMLInputElement).value).toBe("example");
    openPanel();
    openPanel();
    expect((screen.getByLabelText("Export name") as HTMLInputElement).value).toBe("ExampleTool");

    fireEvent.click(screen.getByRole("button", { name: "Install", exact: true }));
    await screen.findByText(/pending approval below/);
    expect(mocks.install).toHaveBeenCalledWith("example-tools", undefined);
    fireEvent.click(screen.getByRole("button", { name: "Approve example-tools" }));
    expect(mocks.approveInstall).toHaveBeenCalledWith("request-1");
  });

  it("preserves wildcard exports and trims manifest inputs", async () => {
    render(<InstallPanel />);
    openPanel();
    fireEvent.change(screen.getByLabelText("Manifest name"), { target: { value: " custom " } });
    fireEvent.change(screen.getByLabelText("Package import path"), { target: { value: " custom-tools " } });
    fireEvent.change(screen.getByLabelText("Required env vars"), { target: { value: " A, B, " } });
    fireEvent.click(screen.getByRole("button", { name: "Add manifest", exact: true }));

    await waitFor(() => expect(mocks.createManifest).toHaveBeenCalledWith({
      name: "custom",
      package: "custom-tools",
      export: "*",
      category: "Web",
      capability: "execute",
      requiredEnv: ["A", "B"],
    }));
    await waitFor(() => expect((screen.getByLabelText("Manifest name") as HTMLInputElement).value).toBe(""));
  });
});
