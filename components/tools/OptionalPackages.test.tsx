// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { OptionalPackages } from "./OptionalPackages";

const mocks = vi.hoisted(() => ({
  optional: vi.fn(),
  install: vi.fn(),
  errorToast: vi.fn(),
}));

vi.mock("@/api/client", () => ({
  api: { dependencies: { optional: mocks.optional, install: mocks.install } },
}));
vi.mock("@/lib/ui/error-report", () => ({ pushErrorToast: mocks.errorToast }));

const transformers = {
  id: "@huggingface/transformers",
  category: "embeddings" as const,
  label: "Local embeddings",
  summary: "Runs the bundled embedding model locally.",
  withoutIt: "Recall uses lexical matching only.",
  sizeMb: 426,
  docsUrl: null,
  target: "runtime:@huggingface/transformers",
  state: "missing" as const,
  installable: true,
  detail: null,
  hint: null,
};

const copilot = {
  id: "@microsoft/copilot-sdk",
  category: "agent-runtimes" as const,
  label: "GitHub Copilot runtime",
  summary: "Lets copilot_delegate run a coding task.",
  withoutIt: "copilot_delegate is unavailable.",
  sizeMb: 206,
  docsUrl: null,
  target: "runtime:@microsoft/copilot-sdk",
  state: "satisfied" as const,
  installable: true,
  detail: null,
  hint: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.optional.mockResolvedValue({
    packages: [transformers, copilot],
    categories: [
      { id: "embeddings", label: "Embeddings and recall", pendingSizeMb: 426, packages: [transformers] },
      { id: "agent-runtimes", label: "Agent runtimes", pendingSizeMb: 0, packages: [copilot] },
    ],
  });
  mocks.install.mockResolvedValue({ status: "installed" });
});

it("shows optional packages by category with what happens without them", async () => {
  render(<OptionalPackages />);

  expect(await screen.findByText("Embeddings and recall")).toBeTruthy();
  expect(screen.getByText("Agent runtimes")).toBeTruthy();
  expect(screen.getByText("Without it: Recall uses lexical matching only.")).toBeTruthy();
  expect(screen.getByText("≈426 MB not installed")).toBeTruthy();
  // Installed packages show state instead of an install button.
  expect(screen.getByText("Installed")).toBeTruthy();
});

it("installs a missing package through its runtime target and refreshes", async () => {
  render(<OptionalPackages />);

  const button = await screen.findByRole("button", { name: /install/i });
  fireEvent.click(button);

  await waitFor(() => expect(mocks.install).toHaveBeenCalledWith("runtime:@huggingface/transformers"));
  await waitFor(() => expect(mocks.optional).toHaveBeenCalledTimes(2));
});

it("reports a blocked install instead of pretending it worked", async () => {
  mocks.install.mockResolvedValue({ status: "blocked", error: "Publisher is not allowlisted" });
  render(<OptionalPackages />);

  fireEvent.click(await screen.findByRole("button", { name: /install/i }));

  await waitFor(() => expect(mocks.errorToast).toHaveBeenCalled());
  expect(mocks.errorToast.mock.calls[0]![0]).toMatchObject({ title: "Couldn't install Local embeddings" });
});
