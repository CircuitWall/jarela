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

async function openCard(onResolved?: (action: PendingAction) => Promise<void>) {
  render(<ApprovalsBanner agentId="agent-example" onResolved={onResolved} />);
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

  it("hides answered inputs after submission and does not restore them from a stale poll", async () => {
    await openCard();
    fireEvent.click(screen.getByRole("radio", { name: "Full" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Include examples" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Response recorded");
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit response" })).toBeNull();
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(pending.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit response" })).toBeNull();
    expect(pending.approve).toHaveBeenCalledTimes(1);
  });

  it("supports multiple options in the same card", async () => {
    pending.list.mockResolvedValue([{ ...action, payload: { ...action.payload, multiple: true } }]);
    await openCard();
    fireEvent.click(screen.getByRole("checkbox", { name: "Brief" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Full" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    await waitFor(() => expect(pending.approve).toHaveBeenCalledWith(action.id, { selected_values: ["brief", "full"] }));
  });

  it("preserves an unanswered choice and its draft through chat rerenders and polling", async () => {
    const onResolved = vi.fn().mockResolvedValue(undefined);
    const view = render(<ApprovalsBanner agentId={action.agent_id} onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole("button", { name: /awaiting your response/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Full" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "For the earlier report" } });
    view.rerender(<ApprovalsBanner agentId={action.agent_id} onResolved={onResolved} />);
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(pending.list).toHaveBeenCalledTimes(2));
    expect((screen.getByRole("radio", { name: "Full" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("For the earlier report");
    expect(pending.approve).not.toHaveBeenCalled();
    expect(pending.deny).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    await waitFor(() => expect(pending.approve).toHaveBeenCalledWith(action.id, {
      selected_values: ["full"], text: "For the earlier report",
    }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it("keeps Approve/Deny for artifact edits and displays their before/after payload", async () => {
    pending.list.mockResolvedValue([{
      ...action, kind: "write_skill",
      payload: { id: "example", expected_content: "# Before", content: "# After" },
    }]);
    await openCard();
    fireEvent.click(screen.getByText("Review full before/after text"));
    expect((screen.getByRole("textbox", { name: "Before" }) as HTMLTextAreaElement).value).toBe("# Before");
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

  it("retains a terminal error across polls without allowing another approval attempt", async () => {
    const onResolved = vi.fn();
    pending.approve.mockResolvedValue({ ...action, status: "failed", result: "Stale content" });
    await openCard(onResolved);
    fireEvent.click(screen.getByRole("radio", { name: "Brief" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Stale content");
    pending.list.mockResolvedValue([]);
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(pending.list).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert").textContent).toBe("Stale content");
    expect(screen.queryByRole("button", { name: "Submit response" })).toBeNull();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("continues after saving an answer and retries only chat if continuation fails", async () => {
    const onResolved = vi.fn().mockRejectedValueOnce(new Error("Chat unavailable")).mockResolvedValue(undefined);
    await openCard(onResolved);
    fireEvent.click(screen.getByRole("radio", { name: "Brief" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Outcome saved"));
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: action.id, status: "approved" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry chat continuation" }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(2));
    expect(pending.approve).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("surfaces dismiss failures without pretending the question was dismissed", async () => {
    pending.deny.mockRejectedValue(new Error("Network unavailable"));
    await openCard();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Network unavailable");
    expect(screen.queryByText("Question dismissed")).toBeNull();
  });

  it("lets the user review all long artifact text, including beyond the old preview limits", async () => {
    const before = "# Before\n" + "b".repeat(22000) + "BEFORE END";
    const after = "# After\n" + "a".repeat(22000) + "AFTER END";
    pending.list.mockResolvedValue([{ ...action, kind: "write_skill", payload: {
      id: "long-skill", expected_content: before, content: after,
    } }]);
    await openCard();
    fireEvent.click(screen.getByText("Review full before/after text"));
    expect((screen.getByRole("textbox", { name: "Before" }) as HTMLTextAreaElement).value).toBe(before);
    expect((screen.getByRole("textbox", { name: "After" }) as HTMLTextAreaElement).value).toBe(after);
  });
});
