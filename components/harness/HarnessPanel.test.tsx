// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HARNESS_SECTION_KEYS, type Harness } from "@/api/types";
import { HarnessPanel } from "./HarnessPanel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), setDefault: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  api: { harnesses: { ...mocks, delete: mocks.remove } },
}));
vi.mock("./HarnessEditor", () => ({
  HarnessEditor: ({ harness }: { harness?: Harness }) => <div>Editing {harness?.name ?? "new harness"}</div>,
}));

const source = {
  id: "builtin:default", name: "Synthetic built-in", description: "Synthetic description",
  sections: Object.fromEntries(HARNESS_SECTION_KEYS.map((key) => [key, { enabled: true, text: key }])),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ harnesses: [source], default_harness_id: source.id });
});

it("clones each built-in section without sharing its editable objects, then opens the clone", async () => {
  const created = { ...source, id: "synthetic-copy", name: "Synthetic built-in (copy)" };
  mocks.create.mockResolvedValueOnce(created);
  render(<HarnessPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Clone" }));
  expect(await screen.findByText("Editing Synthetic built-in (copy)")).toBeTruthy();
  expect(mocks.create).toHaveBeenCalledWith({
    name: created.name, description: source.description, sections: source.sections,
  });
  const input = mocks.create.mock.calls[0][0];
  for (const key of HARNESS_SECTION_KEYS) expect(input.sections[key]).not.toBe(source.sections[key]);
  expect(mocks.list).toHaveBeenCalledTimes(2);
});

it("retains the harness list and surfaces clone errors without opening an editor", async () => {
  mocks.create.mockRejectedValueOnce(new Error("Synthetic clone failure"));
  render(<HarnessPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Clone" }));
  await waitFor(() => expect(screen.getByText("Synthetic clone failure")).toBeTruthy());
  expect(screen.queryByText(/Editing/)).toBeNull();
  expect(screen.getByText("Synthetic built-in")).toBeTruthy();
});
