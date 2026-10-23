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
