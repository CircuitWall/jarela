// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingAction } from "@/api/types";

const pending = vi.hoisted(() => ({ list: vi.fn(), approve: vi.fn(), deny: vi.fn() }));
const integrations = vi.hoisted(() => ({
  gmailOauthStart: vi.fn(),
  outlookOauthStart: vi.fn(),
  atlassianOauthStart: vi.fn(),
}));
vi.mock("@/api/client", () => ({ api: { pending, integrations } }));
vi.mock("@/lib/ui/toasts", () => ({ pushToast: vi.fn() }));
import { ApprovalsBanner } from "./ApprovalsBanner";

const AUTHORIZE_URL = "https://auth.example.test/authorize?state=abc";

function oauthAction(integrationId: string): PendingAction {
  return {
    id: `proposal-${integrationId}`, agent_id: "agent-example", kind: "start_oauth",
    payload: { integration_id: integrationId },
    reason: `Authorize ${integrationId}`, status: "pending", result: null,
    created_at: "2026-10-29T18:00:00Z", decided_at: null,
  };
}

let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  openSpy = vi.spyOn(window, "open").mockReturnValue(null);
  for (const start of Object.values(integrations)) {
    start.mockResolvedValue({ authorize_url: AUTHORIZE_URL, state: "abc", redirect_uri: "http://localhost/cb" });
  }
});
afterEach(() => {
  cleanup();
  openSpy.mockRestore();
});

async function approveOauth(integrationId: string) {
  const action = oauthAction(integrationId);
  pending.list.mockResolvedValue([action]);
  pending.approve.mockResolvedValue({ ...action, status: "approved" });
  render(<ApprovalsBanner agentId="agent-example" />);
  fireEvent.click(await screen.findByRole("button", { name: /awaiting your approval/ }));
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  return action;
}

describe("start_oauth approval", () => {
  it.each([
    ["gmail", "gmailOauthStart"],
    ["outlook", "outlookOauthStart"],
    ["atlassian", "atlassianOauthStart"],
  ] as const)("opens the %s authorize URL after approval", async (id, starter) => {
    await approveOauth(id);
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(AUTHORIZE_URL, "_blank", "noopener,noreferrer"));
    expect(integrations[starter]).toHaveBeenCalledWith({});
    for (const [name, fn] of Object.entries(integrations)) {
      if (name !== starter) expect(fn).not.toHaveBeenCalled();
    }
  });

  it("does not start OAuth when the approval itself fails", async () => {
    const action = oauthAction("atlassian");
    pending.list.mockResolvedValue([action]);
    pending.approve.mockResolvedValue({ ...action, status: "failed", result: "unknown integration" });
    render(<ApprovalsBanner agentId="agent-example" />);
    fireEvent.click(await screen.findByRole("button", { name: /awaiting your approval/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(pending.approve).toHaveBeenCalled());
    expect(integrations.atlassianOauthStart).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("reports an error instead of silently doing nothing for an integration without an OAuth starter", async () => {
    await approveOauth("notion");
    expect(await screen.findByText(/no oauth start flow for "notion"/i)).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("surfaces start failures from the API", async () => {
    integrations.atlassianOauthStart.mockRejectedValue(new Error("client_id and client_secret are required"));
    await approveOauth("atlassian");
    expect(await screen.findByText(/client_id and client_secret are required/)).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
