// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AuthoringOperationPreview } from "./AuthoringOperationPreview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows exact diff, destination and effects without treating a fetched preview as approval", async () => {
  const reviewed = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
    stage: "push", destination: "example/fixture", diff: "-old\n+new", revision: "a".repeat(64),
  }) })));
  render(<AuthoringOperationPreview id="synthetic" type="contribution" onReviewed={reviewed} />);
  expect((await screen.findByLabelText("Exact authoring operation")).textContent).toContain("example/fixture");
  expect(screen.getByText(/NOT a sandbox/)).toBeTruthy();
  expect(reviewed).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(reviewed).toHaveBeenLastCalledWith(true);
});
it("keeps unavailable review non-actionable and resets acknowledgement for a new identity", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
  const reviewed = vi.fn();
  render(<AuthoringOperationPreview id="expired" type="extension" onReviewed={reviewed} />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(reviewed).toHaveBeenLastCalledWith(false);
});
