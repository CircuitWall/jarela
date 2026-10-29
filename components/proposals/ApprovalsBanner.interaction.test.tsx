// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingAction } from "@/api/types";

const pending = vi.hoisted(() => ({ list: vi.fn(), approve: vi.fn(), deny: vi.fn() }));
vi.mock("@/api/client", () => ({ api: { pending } }));
vi.mock("@/lib/ui/toasts", () => ({ pushToast: vi.fn() }));
import { ApprovalsBanner } from "./ApprovalsBanner";

const action: PendingAction = {
  id: "proposal-example", agent_id: "agent-example", kind: "ask_choice",
  payload: {
    question: "Which output format?",
    options: [{ value: "brief", label: "Brief" }, { value: "full", label: "Full" }],
    allow_text: true,
  },
  reason: "Choose an output format", status: "pending", result: null,
  created_at: "2026-10-29T18:00:00Z", decided_at: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  pending.list.mockResolvedValue([action]);
  pending.approve.mockResolvedValue({ ...action, status: "approved" });
  pending.deny.mockResolvedValue({ ...action, status: "denied" });
});
afterEach(cleanup);

async function openCard() {
  render(<ApprovalsBanner agentId="agent-example" />);
  fireEvent.click(await screen.findByRole("button", { name: /awaiting your (approval|response)/ }));
}

describe("shared choice and approval review card", () => {
  it("submits a choice and optional text through the existing proposal endpoint", async () => {
    await openCard();
    const submit = screen.getByRole("button", { name: "Submit response" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Full" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Include examples" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(pending.approve).toHaveBeenCalledWith(action.id, {
      selected_values: ["full"], text: "Include examples",
    }));
  });

  it("dismisses a question without sending an answer", async () => {
    await openCard();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(pending.deny).toHaveBeenCalledWith(action.id));
    expect(pending.approve).not.toHaveBeenCalled();
  });

  it("supports multiple options in the same card", async () => {
    pending.list.mockResolvedValue([{ ...action, payload: { ...action.payload, multiple: true } }]);
    await openCard();
    fireEvent.click(screen.getByRole("checkbox", { name: "Brief" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Full" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    await waitFor(() => expect(pending.approve).toHaveBeenCalledWith(action.id, { selected_values: ["brief", "full"] }));
  });

  it("keeps Approve/Deny for artifact edits and displays their before/after payload", async () => {
    pending.list.mockResolvedValue([{
      ...action, kind: "write_skill",
      payload: { id: "example", expected_content: "# Before", content: "# After" },
    }]);
    await openCard();
    expect(screen.getByText(/# Before/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(pending.approve).toHaveBeenCalledWith(action.id, undefined));
  });

  it("shows failed application instead of a success-shaped response", async () => {
    pending.approve.mockResolvedValue({ ...action, status: "failed", result: "Content changed" });
    await openCard();
    fireEvent.click(screen.getByRole("radio", { name: "Brief" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Content changed");
  });
});
