// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { AddCredentialDialog } from "./AddCredentialDialog";

const mocks = vi.hoisted(() => ({ list: vi.fn(), toast: vi.fn() }));
vi.mock("@/api/client", () => ({ api: { integrations: { list: mocks.list } } }));
vi.mock("@/lib/ui/error-report", () => ({ pushErrorToast: mocks.toast }));
vi.mock("@/components/ui/Dialog", () => ({ Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("./IntegrationCard", () => ({ IntegrationCard: () => <div>Credential form</div> }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({
    definitions: [{ name: "openai", label: "OpenAI", category: "llm" }], statuses: [],
  });
});

it.each([undefined, "openai"])("retries catalog failure without claiming providers are unavailable (direct=%s)", async (directProviderName) => {
  mocks.list.mockRejectedValueOnce(new Error("Synthetic connection failure"));
  render(<AddCredentialDialog directProviderName={directProviderName} onClose={vi.fn()} />);

  expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load credential providers.");
  expect(screen.queryByText("No credential providers available.")).toBeNull();
  expect(screen.queryByText(/No credential form is available/)).toBeNull();
  expect(mocks.toast).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  if (directProviderName) await screen.findByText("Credential form");
  else await screen.findByText("OpenAI");
  expect(screen.queryByRole("alert")).toBeNull();
});

function mockProfileCatalog() {
  mocks.list.mockResolvedValue({
    definitions: [
      { name: "mail", label: "Example mail", category: "mail", description: "Mail" },
      { name: "issues", label: "Example issues", category: "issue-tracker", description: "Issues" },
      { name: "saved", label: "Saved infrastructure", category: "infrastructure", description: "Infrastructure" },
    ],
    statuses: [{ name: "saved", configured: true }],
  });
}

it("filters Home discovery while preserving saved integrations and offering Show all", async () => {
  mockProfileCatalog();
  render(<AddCredentialDialog usageProfile="home" onClose={vi.fn()} />);
  expect(await screen.findByText("Example mail")).toBeTruthy();
  expect(screen.getByText("Saved infrastructure")).toBeTruthy();
  expect(screen.queryByText("Example issues")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show all integrations" }));
  expect(screen.getByText("Example issues")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use agent profile" }));
  expect(screen.queryByText("Example issues")).toBeNull();
});

it("does not block editing a provider outside the profile", async () => {
  mockProfileCatalog();
  render(<AddCredentialDialog usageProfile="home" directProviderName="issues" onClose={vi.fn()} />);
  expect(await screen.findByText("Credential form")).toBeTruthy();
});

it("keeps explicit category constraints when showing all integrations", async () => {
  mockProfileCatalog();
  render(<AddCredentialDialog usageProfile="home" initialCategory="mail" lockCategory onClose={vi.fn()} />);
  expect(await screen.findByText("Example mail")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show all integrations" }));
  expect(screen.queryByText("Example issues")).toBeNull();
  expect(screen.queryByText("Saved infrastructure")).toBeNull();
});
