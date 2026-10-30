// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AuthoringWorkflows } from "./AuthoringWorkflows";

vi.mock("@/api/client", () => ({ api: { agents: { list: async () => [{ id: "synthetic-agent", name: "Synthetic" }] } } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("loads an inert example without executing or requesting approval", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<AuthoringWorkflows />);
  await screen.findByRole("option", { name: "Synthetic" });
  fireEvent.click(screen.getByText("Load inert authoring example"));
  expect(screen.getByLabelText<HTMLTextAreaElement>("Authoring request JSON").value).toContain('"decision": "author"');
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Submit authoring request" }).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Approve this authoring stage" })).toBeNull();
});
