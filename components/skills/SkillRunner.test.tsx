// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillRunner } from "./SkillRunner";

vi.mock("@/api/client", () => ({ api: { agents: { list: async () => [{ id: "synthetic-agent", name: "Synthetic agent" }] } } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("checked skill controls", () => {
  it("submits exact inputs, distinguishes pending review and exposes refresh/cancel", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ request_id: "synthetic-request", status: "pending" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "finished", result: { status: "succeeded" } }) })
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "Already finished" }) });
    vi.stubGlobal("fetch", fetch);
    render(<SkillRunner skills={[]} />);
    await screen.findByRole("option", { name: "Synthetic agent" });
    fireEvent.change(screen.getByLabelText("Canonical absolute workspace"), { target: { value: "C:\\synthetic" } });
    const input = '{ "now": "2026-10-30T00:00:00Z", "entries": [] }';
    fireEvent.change(screen.getByLabelText("Exact invocation JSON"), { target: { value: input } });
    fireEvent.click(screen.getByRole("button", { name: "Request execution" }));
    await screen.findByRole("status");
    expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify({
      agent_id: "synthetic-agent", skill_id: "memory-organization", workspace: "C:\\synthetic", input_json: input,
    }));
    expect(screen.getByText(/Pending is not success/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh result" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("succeeded"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel execution" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Already finished");
    expect(fetch.mock.calls[2][1].method).toBe("DELETE");
  });
});
