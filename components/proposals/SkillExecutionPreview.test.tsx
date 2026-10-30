// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SkillExecutionPreview } from "./SkillExecutionPreview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows exact arguments and code and requires explicit full-trust acknowledgement", async () => {
  const reviewed = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
    input_json: '{"synthetic":true}', artifact_revision: "a".repeat(64), workspace: "synthetic-workspace",
    runtime_version: "v24", timeout_ms: 5000, max_output_bytes: 65536, expires_at: "2026-10-30T00:05:00Z",
    files: [{ path: "scripts/run.mjs", sha256: "b".repeat(64), bytes: 7, base64: btoa("code();") }],
  }) })));
  render(<SkillExecutionPreview requestId="synthetic" onReviewed={reviewed} />);
  expect(await screen.findByText('{"synthetic":true}')).toBeTruthy();
  expect(screen.getByText("code();")).toBeTruthy();
  expect(screen.getByText(/NOT sandboxed/)).toBeTruthy();
  expect(reviewed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(reviewed).toHaveBeenLastCalledWith(true);
});
it("shows an expired request error without enabling approval", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
  const reviewed = vi.fn();
  render(<SkillExecutionPreview requestId="expired" onReviewed={reviewed} />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(reviewed).not.toHaveBeenCalled();
});
