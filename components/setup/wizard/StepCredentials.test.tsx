// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { StepCredentials } from "./StepCredentials";

vi.mock("@/components/credentials/AddCredentialDialog", () => ({
  AddCredentialDialog: ({ onSaved }: { onSaved: () => void }) => <button onClick={onSaved}>Save credential</button>,
}));

const definitions = [
  { name: "openai", label: "OpenAI", category: "llm", description: "Connect OpenAI." },
  { name: "claude-code", label: "Claude Code", category: "llm", description: "Optional runtime." },
  { name: "gmail", label: "Gmail", category: "integration", description: "Connect mail." },
];

it("keeps first-run credentials focused on LLM providers", () => {
  render(
    <StepCredentials
      definitions={definitions}
      integrations={[]}
      onChanged={vi.fn()}
      firstRun
    />,
  );

  expect(screen.getByText("Let's connect a model provider")).toBeTruthy();
    expect(screen.getByText("Let's connect a model provider")).toBeTruthy();
  expect(screen.getByText("OpenAI")).toBeTruthy();
  expect(screen.queryByText("Search engines")).toBeNull();
  expect(screen.queryByText("Agent runtime")).toBeNull();
  expect(screen.queryByRole("button", { name: /Import existing env/i })).toBeNull();
  expect(screen.queryByText("Gmail")).toBeNull();
});

it("immediately reports the provider after a credential is saved", () => {
  const onConfigured = vi.fn();
  const onChanged = vi.fn();
  render(
    <StepCredentials
      definitions={definitions}
      integrations={[]}
      onChanged={onChanged}
      onConfigured={onConfigured}
      firstRun
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

  expect(onConfigured).toHaveBeenCalledWith("openai");
  expect(onChanged).toHaveBeenCalledOnce();
});
