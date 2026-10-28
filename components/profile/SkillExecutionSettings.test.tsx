// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillExecutionSettings } from "./SkillExecutionSettings";
import { defaultSkillExecutionPolicy, type SkillExecutionPolicy } from "@/lib/skills/execution-policy";

const fetchMock = vi.fn();
function response(policy: SkillExecutionPolicy = defaultSkillExecutionPolicy(), safety_mode = "mostly_safe") {
  return { ok: true, json: async () => ({ policy, safety_mode, execution_available: false }) };
}
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(response());
});
afterEach(() => vi.unstubAllGlobals());

describe("skill execution Security settings", () => {
  it("loads defaults, explains runner availability and persists a user-selected policy", async () => {
    render(<SkillExecutionSettings />);
    const select = await screen.findByLabelText("Consent policy");
    await waitFor(() => expect(select.closest("fieldset")?.disabled).toBe(false));
    expect((select as HTMLSelectElement).value).toBe("ask_each_time");
    expect(screen.getByText(/Script execution is not available yet/)).toBeTruthy();
    fireEvent.change(select, { target: { value: "blocked" } });
    fetchMock.mockResolvedValueOnce(response({ mode: "blocked", trusted_revisions: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Save skill execution policy" }));
    expect((await screen.findByRole("status")).textContent).toContain("policy saved");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/v1/security/skill-execution", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ mode: "blocked", trusted_revisions: [] }),
    }));
  });

  it("shows safe mode as authoritative and workflow mode as requiring a bounded plan", async () => {
    fetchMock.mockResolvedValue(response({ mode: "approve_workflow", trusted_revisions: [] }, "safe"));
    render(<SkillExecutionSettings />);
    expect(await screen.findByText(/Safe mode blocks all skill scripts/)).toBeTruthy();
    expect(screen.getByText(/One approval will cover only the declared/)).toBeTruthy();
  });

  it("adds and removes exact trust scopes in a draft before saving", async () => {
    render(<SkillExecutionSettings />);
    await waitFor(() => expect(screen.getByLabelText("Consent policy").closest("fieldset")?.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Consent policy"), { target: { value: "trusted_revisions" } });
    fireEvent.change(screen.getByLabelText("Revision (SHA-256)"), { target: { value: "a".repeat(64) } });
    fireEvent.change(screen.getByLabelText("Agent ID"), { target: { value: "test-agent" } });
    fireEvent.change(screen.getByLabelText("Resolved workspace path"), { target: { value: "/workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Add trust scope to draft" }));
    expect(screen.getByText("Trusted revisions (1/64)")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save skill execution policy" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(save.disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove trusted revision 1" }));
    expect(screen.getByText("Trusted revisions (0/64)")).toBeTruthy();
    expect(save.disabled).toBe(false);
  });

  it("rejects malformed trust without sending it to the server", async () => {
    render(<SkillExecutionSettings />);
    await waitFor(() => expect(screen.getByLabelText("Consent policy").closest("fieldset")?.disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Add trust scope to draft" }));
    expect((await screen.findByRole("alert")).textContent).toContain("SHA-256");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("saves exact acknowledged trust and its configured limits", async () => {
    render(<SkillExecutionSettings />);
    await waitFor(() => expect(screen.getByLabelText("Consent policy").closest("fieldset")?.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Consent policy"), { target: { value: "trusted_revisions" } });
    fireEvent.change(screen.getByLabelText("Revision (SHA-256)"), { target: { value: "b".repeat(64) } });
    fireEvent.change(screen.getByLabelText("Agent ID"), { target: { value: "agent-2" } });
    fireEvent.change(screen.getByLabelText("Resolved workspace path"), { target: { value: "/workspace" } });
    fireEvent.change(screen.getByLabelText("Maximum timeout (ms)"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("Maximum output (bytes)"), { target: { value: "128" } });
    fireEvent.click(screen.getByRole("button", { name: "Add trust scope to draft" }));
    fireEvent.click(screen.getByRole("checkbox"));
    const saved: SkillExecutionPolicy = {
      mode: "trusted_revisions", trusted_revisions: [{
        revision: "b".repeat(64), agent_id: "agent-2", workspace: "/workspace",
        max_timeout_ms: 1000, max_output_bytes: 128,
      }],
    };
    fetchMock.mockResolvedValueOnce(response(saved));
    fireEvent.click(screen.getByRole("button", { name: "Save skill execution policy" }));
    await screen.findByRole("status");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/v1/security/skill-execution", expect.objectContaining({
      method: "PUT", body: JSON.stringify(saved),
    }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("rejects an invalid server response rather than showing usable defaults", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ policy: defaultSkillExecutionPolicy() }) });
    render(<SkillExecutionSettings />);
    expect((await screen.findByRole("alert")).textContent).toContain("Invalid skill execution settings response");
    expect(screen.getByLabelText("Consent policy").closest("fieldset")?.disabled).toBe(true);
  });

  it("shows a durable approval record and allows it to be removed", async () => {
    fetchMock.mockResolvedValue(response({
      mode: "trusted_revisions", trusted_revisions: [{
        revision: "a".repeat(64), agent_id: "test-agent", workspace: "/workspace",
        max_timeout_ms: 60_000, max_output_bytes: 65_536,
        approval: { id: "00000000-0000-4000-8000-000000000001", approved_at: "2026-10-28T00:00:00.000Z" },
      }],
    }));
    render(<SkillExecutionSettings />);
    expect(await screen.findByText(/Approved 2026-10-28T00:00:00.000Z/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove trusted revision 1" }));
    fetchMock.mockResolvedValueOnce(response({ mode: "trusted_revisions", trusted_revisions: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Save skill execution policy" }));
    await screen.findByRole("status");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/v1/security/skill-execution", expect.objectContaining({
      body: JSON.stringify({ mode: "trusted_revisions", trusted_revisions: [] }),
    }));
  });

  it("keeps saving disabled on load failure and exposes the error", async () => {
    fetchMock.mockRejectedValue(new Error("Cannot load security settings"));
    render(<SkillExecutionSettings />);
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot load security settings");
    expect(screen.getByRole("button", { name: "Save skill execution policy" }).closest("fieldset")?.disabled).toBe(true);
  });

  it("shows server refusal without claiming a successful save", async () => {
    render(<SkillExecutionSettings />);
    await waitFor(() => expect(screen.getByLabelText("Consent policy").closest("fieldset")?.disabled).toBe(false));
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "loopback-only" }) });
    fireEvent.click(screen.getByRole("button", { name: "Save skill execution policy" }));
    expect((await screen.findByRole("alert")).textContent).toContain("loopback-only");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
