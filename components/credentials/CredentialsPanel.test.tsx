// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Credential } from "@/api/types";
import { CredentialsListPanel, CredentialsPanel } from "./CredentialsPanel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), integrations: vi.fn(), agent: vi.fn(), remove: vi.fn(), dispatch: vi.fn(),
  selection: "list",
}));
vi.mock("@/api/client", () => ({
  api: {
    credentials: { list: mocks.list, delete: mocks.remove },
    integrations: { list: mocks.integrations }, agents: { get: mocks.agent },
  },
}));
vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({
    state: { activeAgentId: "synthetic-agent", selectedItem: { credentials: mocks.selection } },
    dispatch: mocks.dispatch,
  }),
}));
vi.mock("@/components/integrations/EnvSync", () => ({
  useEnvSync: () => ({}), EnvSyncButton: () => null, EnvSyncNotice: () => null,
}));
vi.mock("@/hooks/useCredentialProbes", () => ({ useCredentialProbes: () => new Map() }));
vi.mock("@/hooks/useDeepLinkScroll", () => ({ useDeepLinkScroll: vi.fn() }));
vi.mock("@/components/integrations/NetworkPanel", () => ({ NetworkPanel: () => <div>Network settings</div> }));
vi.mock("./IntegrationCard", () => ({ IntegrationCard: () => null }));
vi.mock("./AddCredentialDialog", () => ({
  AddCredentialDialog: ({ credential, directProviderName, createNew, onClose }: {
    credential?: Credential; directProviderName?: string; createNew?: boolean; onClose: () => void;
  }) => <div>
    <span>{credential ? `Editing ${credential.id}` : createNew ? `New ${directProviderName} row` : "Discover credentials"}</span>
    <button onClick={onClose}>Close credential editor</button>
  </div>,
}));

function credential(id: string, isDefault: boolean) {
  return {
    id, is_default: isDefault, type: "integration", provider: "issues", label: id,
    auth_method: "api_key", params: {}, created_at: "", updated_at: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selection = "list";
  mocks.list.mockResolvedValue([credential("first", false), credential("preferred", true)]);
  mocks.integrations.mockResolvedValue({
    definitions: [{ name: "issues", label: "Synthetic issues", category: "issue-tracker" }],
    statuses: [],
  });
  mocks.agent.mockResolvedValue({ usage_profile: "home" });
});

it("preserves saved providers outside discovery filtering, with default credentials first", async () => {
  const { container } = render(<CredentialsListPanel />);
  fireEvent.click(await screen.findByRole("button", { name: /Tool credentials/ }));
  expect(await screen.findByText("Synthetic issues")).toBeTruthy();
  const rows = [...container.querySelectorAll("li[data-deep-link-id]")];
  expect(rows.map((node) => node.getAttribute("data-deep-link-id"))).toEqual(["preferred", "first"]);
  fireEvent.click(screen.getByText("preferred"));
  expect(screen.getByText("Editing preferred")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close credential editor" }));
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Add another" }));
  expect(screen.getByText("New issues row")).toBeTruthy();
});

it("does not open the editor on delete failure and retains the credential and error", async () => {
  mocks.remove.mockRejectedValueOnce(new Error("Synthetic deletion failure"));
  render(<CredentialsListPanel />);
  fireEvent.click(await screen.findByRole("button", { name: /Tool credentials/ }));
  const row = (await screen.findByText("preferred")).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
  expect(await screen.findByText('Could not delete "preferred": Synthetic deletion failure')).toBeTruthy();
  expect(screen.queryByText("Editing preferred")).toBeNull();
  expect(screen.getByText("preferred")).toBeTruthy();
  expect(mocks.remove).toHaveBeenCalledWith("preferred");
});

it("honors the legacy integrations selection as the network sub-tab", () => {
  mocks.selection = "integrations";
  render(<CredentialsPanel />);
  expect(screen.getByText("Network settings")).toBeTruthy();
  expect(mocks.list).not.toHaveBeenCalled();
});
