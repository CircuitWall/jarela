// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentsPanel } from "./AgentsPanel";

const mocks = vi.hoisted(() => ({
  agent: { id: "synthetic-agent", name: "Synthetic agent", icon: null, identity: "Synthetic identity" },
  listError: null as string | null,
  selectedId: null as string | null,
  empty: false,
  remove: vi.fn(),
  duplicate: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@/hooks/useAgents", () => ({
  useAgents: () => ({
    agents: mocks.empty ? [] : [mocks.agent], loading: false, error: mocks.listError,
    create: vi.fn(), update: vi.fn(), remove: mocks.remove, duplicate: mocks.duplicate,
  }),
}));
vi.mock("@/hooks/useModels", () => ({ useModels: () => ({ models: [] }) }));
vi.mock("@/hooks/useDeepLinkScroll", () => ({ useDeepLinkScroll: vi.fn() }));
vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ state: { selectedItem: { agents: mocks.selectedId } } }),
}));
vi.mock("@/api/client", () => ({
  api: {
    tools: { list: async () => [] }, credentials: { list: async () => [] },
    integrations: { list: async () => [] }, harnesses: { list: async () => [] },
  },
}));
vi.mock("@/lib/ui/confirm", () => ({ confirmAction: mocks.confirm }));
vi.mock("./AgentEditor", () => ({
  AgentEditor: ({ agent, onClose }: { agent?: { name: string }; onClose: () => void }) => (
    <div role="dialog" aria-label={agent?.name ?? "New agent"}>
      <button onClick={onClose}>Close editor</button>
    </div>
  ),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listError = null;
  mocks.selectedId = null;
  mocks.empty = false;
  mocks.confirm.mockResolvedValue(true);
  mocks.remove.mockResolvedValue(undefined);
  mocks.duplicate.mockResolvedValue({ ...mocks.agent, id: "synthetic-copy", name: "Synthetic copy" });
});
afterEach(cleanup);

describe("agent panel feedback and access", () => {
  it("displays load failure instead of a misleading empty-list message", () => {
    mocks.empty = true;
    mocks.listError = "Synthetic load failure";
    render(<AgentsPanel />);
    expect(screen.getByRole("alert").textContent).toContain("Synthetic load failure");
    expect(screen.queryByText(/No agents yet/)).toBeNull();
  });

  it("offers a native edit button alongside separately named actions", () => {
    render(<AgentsPanel />);
    expect(screen.getByRole("button", { name: "Edit Synthetic agent" }).tagName).toBe("BUTTON");
    expect(screen.getByRole("button", { name: "Delete Synthetic agent" })).toBeTruthy();
  });

  it("shows the empty state only after a load error is cleared", () => {
    mocks.empty = true;
    mocks.listError = "Synthetic load failure";
    const { rerender } = render(<AgentsPanel />);
    mocks.listError = null;
    rerender(<AgentsPanel />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/No agents yet/)).toBeTruthy();
  });

  it("keeps editing keyboard-focusable and opens the editor on activation", () => {
    render(<AgentsPanel />);
    const button = screen.getByRole("button", { name: "Edit Synthetic agent" });
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.tabIndex).toBe(0);
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Synthetic agent" })).toBeTruthy();
  });

  it("reports duplicate rejection, releases busy state and allows a successful retry", async () => {
    mocks.duplicate.mockRejectedValueOnce(new Error("Synthetic duplicate failure"));
    render(<AgentsPanel />);
    const button = screen.getByRole("button", { name: "Duplicate Synthetic agent" });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("Synthetic duplicate failure");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button);
    await screen.findByRole("dialog", { name: "Synthetic copy" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports delete rejection without opening the editor and permits a retry", async () => {
    mocks.remove.mockRejectedValueOnce("Synthetic delete failure");
    render(<AgentsPanel />);
    const button = screen.getByRole("button", { name: "Delete Synthetic agent" });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("Synthetic delete failure");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("keeps keyboard delete isolated from editing and respects canceled confirmation", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<AgentsPanel />);
    const button = screen.getByRole("button", { name: "Delete Synthetic agent" });
    button.focus();
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports confirmation failure without attempting deletion", async () => {
    mocks.confirm.mockRejectedValue(new Error("Synthetic confirmation failure"));
    render(<AgentsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Synthetic agent" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Synthetic confirmation failure");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Duplicate", command: "duplicate" },
    { label: "Delete", command: "remove" },
  ] as const)("disables $label while its mutation is pending", async ({ label, command }) => {
    let resolve!: (value: typeof mocks.agent) => void;
    mocks[command].mockReturnValue(new Promise<typeof mocks.agent>((done) => { resolve = done; }));
    render(<AgentsPanel />);
    const button = screen.getByRole("button", { name: `${label} Synthetic agent` });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    fireEvent.click(button);
    expect(mocks[command]).toHaveBeenCalledOnce();
    resolve(mocks.agent);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });

  it("preserves deep-link editor activation and the New action", () => {
    mocks.selectedId = mocks.agent.id;
    render(<AgentsPanel />);
    expect(screen.getByRole("dialog", { name: "Synthetic agent" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByRole("dialog", { name: "New agent" })).toBeTruthy();
  });
});
