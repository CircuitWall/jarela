// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WizardStepper } from "./WizardStepper";

const steps = [
  { id: "profile", title: "About you", short: "Profile" },
  { id: "model", title: "Model", short: "Model" },
  { id: "agent", title: "Your assistant", short: "Agent" },
];

it("shows compact dots while keeping step names accessible and completed steps clickable", () => {
  const onJump = vi.fn();
  render(<WizardStepper steps={steps} current={1} onJump={onJump} />);

  expect(screen.queryByText("Profile")).toBeNull();
  expect(screen.queryByText("Model")).toBeNull();
  expect(screen.getByRole("button", { name: "Step 1: About you (complete)" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Step 2: Model (current)" }).getAttribute("aria-current")).toBe("step");
  fireEvent.click(screen.getByRole("button", { name: "Step 1: About you (complete)" }));
  expect(onJump).toHaveBeenCalledWith(0);
});
