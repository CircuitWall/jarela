// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { StepAgent } from "./StepAgent";
import { StepCredentials } from "./StepCredentials";
import { StepModel } from "./StepModel";

vi.mock("@/components/models/ProviderLogo", () => ({ ProviderLogo: () => null }));

it("keeps credentials and model steps read-only during a wizard rerun", () => {
  const { unmount } = render(
    <StepCredentials
      definitions={[{ name: "openai", label: "OpenAI", category: "llm", description: "" }]}
      integrations={[]}
      onChanged={vi.fn()}
      readOnly
    />,
  );
  expect(screen.getByText(/provider connections and search settings will stay as they are/i)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();

  unmount();
  render(
    <StepModel
      models={[{ name: "default", provider: "openai", model_id: "gpt-test", is_default: true }]}
      onChanged={vi.fn()}
      readOnly
    />,
  );
  expect(screen.getByText(/I'll leave it just as it is/i)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

it("does not offer agent creation or editing during a rerun review", () => {
  render(<StepAgent agents={[]} models={[]} onChanged={vi.fn()} readOnly />);

  expect(screen.getByText(/Exit this review to return to your profile without changing anything/i)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
