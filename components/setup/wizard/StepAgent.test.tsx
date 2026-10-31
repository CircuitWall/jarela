// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StepAgent } from "./StepAgent";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("preserves the first-run 1 MB limit and permits retrying after a read error", () => {
  const onIconChange = vi.fn();
  const readers: FileReader[] = [];
  const read = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
    readers.push(this);
  });
  const { container } = render(
    <StepAgent agents={[]} models={[]} onChanged={vi.fn()} starter={{
      name: "Synthetic", onNameChange: vi.fn(), icon: null, onIconChange,
      goal: "", onGoalChange: vi.fn(),
    }} />,
  );
  const input = container.querySelector('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File([new Uint8Array(1024 * 1024 + 1)], "large.png")] } });
  expect(screen.getByRole("alert").textContent).toBe("Choose an image smaller than 1 MB.");
  expect(read).not.toHaveBeenCalled();
  const file = new File([new Uint8Array(1024 * 1024)], "boundary.png");
  fireEvent.change(input, { target: { files: [file] } });
  expect(read).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => readers[0].dispatchEvent(new ProgressEvent("error")));
  expect(screen.getByRole("alert").textContent).toContain("Could not read that image");
  expect(onIconChange).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { files: [file] } });
  act(() => {
    Object.defineProperty(readers[1], "result", { value: "data:image/png;base64,retry" });
    readers[1].dispatchEvent(new ProgressEvent("load"));
  });
  expect(onIconChange).toHaveBeenCalledWith("data:image/png;base64,retry");
  expect(screen.queryByRole("alert")).toBeNull();
});

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
