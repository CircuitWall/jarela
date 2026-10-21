// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { StepAgent } from "./StepAgent";

it("keeps first-run assistant setup to identity and a starting goal", () => {
  const onNameChange = vi.fn();
  render(
    <StepAgent
      agents={[]}
      models={[]}
      onChanged={vi.fn()}
      starter={{
        name: "",
        onNameChange,
        icon: null,
        onIconChange: vi.fn(),
        goal: "",
        onGoalChange: vi.fn(),
      }}
    />,
  );

  expect(screen.getByText(/What should I call myself/)).toBeTruthy();
  expect(screen.getByText(/What would you like me to help with first/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Choose assistant icon" })).toBeTruthy();
  expect(screen.queryByText("Instructions")).toBeNull();
  expect(screen.queryByText("Tools")).toBeNull();
  expect(screen.getByText("Give me a name so we can get started.")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: /What should I call myself/ }), { target: { value: "Nova" } });
  expect(onNameChange).toHaveBeenCalledWith("Nova");
});
