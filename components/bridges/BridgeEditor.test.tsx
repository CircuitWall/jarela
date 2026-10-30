// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bridge, BridgeModuleInfo } from "@/api/types";
import { BridgeEditor } from "./BridgeEditor";

const mocks = vi.hoisted(() => ({
  status: vi.fn(), pair: vi.fn(), chats: vi.fn(), lookup: vi.fn(),
  agents: vi.fn(), models: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
  addIgnore: vi.fn(), removeIgnore: vi.fn(), patch: vi.fn(), toggle: vi.fn(),
  rename: vi.fn(), confirm: vi.fn(), toast: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  api: {
    bridges: { status: mocks.status, pair: mocks.pair, chats: mocks.chats, lookup: mocks.lookup },
    agents: { list: mocks.agents }, models: { list: mocks.models },
  },
}));
vi.mock("@/hooks/useBridges", () => ({
  useBridgeRoutes: () => ({ routes: [], create: mocks.create, update: mocks.update, remove: mocks.remove }),
  useBridgeIgnores: () => ({ ignores: [], add: mocks.addIgnore, remove: mocks.removeIgnore }),
}));
vi.mock("@/lib/ui/confirm", () => ({ confirmAction: mocks.confirm }));
vi.mock("@/lib/ui/error-report", () => ({ pushErrorToast: mocks.toast }));

const bridge: Bridge = {
  id: "synthetic-bridge", kind: "synthetic", name: "Synthetic bridge", status: "connected",
  enabled: false, last_error: null, paired_id: null, created_at: "", updated_at: "",
  event_subscriptions: { group_profile_updates: false, group_participants_updates: false },
};
const moduleInfo: BridgeModuleInfo = {
  kind: "synthetic", label: "Synthetic", description: "", setupInstructions: "",
  remoteIdLabel: "Remote ID", remoteIdPlaceholder: "chat@example.test",
  chatDirectory: true, groupEventSubscriptions: true,
  chatLookup: { inputType: "text", placeholder: "Find identity", notFoundMessage: "No synthetic match", description: "" },
  pairing: { actionLabel: "Pair again", confirmMessage: "Synthetic pairing?", qrAlt: "Pairing code", qrInstructions: "" },
};

function renderEditor() {
  return render(<BridgeEditor bridge={bridge} module={moduleInfo} onBack={vi.fn()}
    onRename={mocks.rename} onToggleEnabled={mocks.toggle} onPatch={mocks.patch} />);
}

function section(title: string) {
  return within(screen.getByText(title, { selector: "h3" }).closest("section")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({ status: "connected" });
  mocks.chats.mockResolvedValue({ chats: [], running: true });
  mocks.agents.mockResolvedValue([{ id: "agent-1", name: "Synthetic listener", model_config_name: null }]);
  mocks.models.mockResolvedValue([]);
  mocks.confirm.mockResolvedValue(true);
  mocks.pair.mockResolvedValue({});
  mocks.patch.mockResolvedValue({});
  mocks.create.mockResolvedValue({});
});

afterEach(() => vi.useRealTimers());

it("polls chat directories only while either add form is active and stops on cleanup", async () => {
  vi.useFakeTimers();
  let view: ReturnType<typeof render>;
  await act(async () => { view = renderEditor(); });
  expect(mocks.chats).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(section("Routes").getByRole("button", { name: "Add" })); });
  expect(mocks.chats).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(mocks.chats).toHaveBeenCalledTimes(2);
  await act(async () => { fireEvent.click(section("Routes").getByRole("button", { name: "Cancel" })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(mocks.chats).toHaveBeenCalledTimes(2);
  await act(async () => { fireEvent.click(section("Ignored chats").getByRole("button", { name: "Add" })); });
  expect(mocks.chats).toHaveBeenCalledTimes(3);
  view!.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  expect(mocks.chats).toHaveBeenCalledTimes(3);
});

it("looks up a chat, keeps its selected metadata and creates the same route payload", async () => {
  mocks.lookup.mockResolvedValue({ chat: { remote_jid: "synthetic-chat", name: "Synthetic support" } });
  renderEditor();
  fireEvent.click(section("Routes").getByRole("button", { name: "Add" }));
  fireEvent.change(screen.getByPlaceholderText("Find identity"), { target: { value: " synthetic lookup " } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  expect(await screen.findByText("Synthetic support")).toBeTruthy();
  fireEvent.change(section("Routes").getByRole("combobox"), { target: { value: "agent-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Add route" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
    remote_jid: "synthetic-chat", agent_id: "agent-1", label: "Synthetic support",
  }));
  expect(mocks.lookup).toHaveBeenCalledWith(bridge.id, "synthetic lookup");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Add route" })).toBeNull());
});

it("creates a catch-all without requiring a synced chat", async () => {
  renderEditor();
  fireEvent.click(section("Routes").getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Catch everything else/ }));
  await screen.findByRole("option", { name: /Synthetic listener/ });
  fireEvent.change(section("Routes").getByRole("combobox"), { target: { value: "agent-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Add route" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
    remote_jid: "*", agent_id: "agent-1", label: "Catch-all",
  }));
});

it("pairs before enabling a paused bridge and preserves individual subscription patches", async () => {
  renderEditor();
  fireEvent.click(screen.getByRole("button", { name: "Pair again" }));
  await waitFor(() => expect(mocks.toggle).toHaveBeenCalledOnce());
  expect(mocks.pair).toHaveBeenCalledWith(bridge.id);
  expect(mocks.pair.mock.invocationCallOrder[0]).toBeLessThan(mocks.toggle.mock.invocationCallOrder[0]);
  fireEvent.click(screen.getByRole("checkbox", { name: /Group profile\/settings updates/ }));
  await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith({
    event_subscriptions: { group_profile_updates: true },
  }));
});

it("trims manually ignored chats and retains the input on API failure", async () => {
  mocks.addIgnore.mockRejectedValueOnce(new Error("Synthetic ignore failure")).mockResolvedValueOnce({});
  renderEditor();
  fireEvent.click(section("Ignored chats").getByRole("button", { name: "Add" }));
  const input = screen.getByPlaceholderText(moduleInfo.remoteIdPlaceholder);
  fireEvent.change(input, { target: { value: " synthetic-private-chat " } });
  fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
  expect(await screen.findByText("Synthetic ignore failure")).toBeTruthy();
  expect(input).toHaveProperty("value", " synthetic-private-chat ");
  fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
  await waitFor(() => expect(input).toHaveProperty("value", ""));
  expect(mocks.addIgnore).toHaveBeenLastCalledWith({ remote_jid: "synthetic-private-chat", label: null });
});

it("does not enable the bridge when pairing fails", async () => {
  mocks.pair.mockRejectedValueOnce(new Error("Synthetic pairing failure"));
  renderEditor();
  fireEvent.click(screen.getByRole("button", { name: "Pair again" }));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
    title: "Couldn't re-pair bridge",
  })));
  expect(mocks.toggle).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Pair again" })).toHaveProperty("disabled", false);
});
