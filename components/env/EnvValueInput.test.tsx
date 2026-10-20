// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EnvValueInput } from "./EnvValueInput";

describe("EnvValueInput", () => {
  it("renders schema choices and emits only a selected option", () => {
    const onChange = vi.fn();
    render(
      <EnvValueInput
        type="enum"
        value="info"
        enumValues={["debug", "info", "warn", "error"]}
        onChange={onChange}
      />,
    );

    const select = screen.getByRole("combobox");
    expect(Array.from(select.querySelectorAll("option")).map((option) => option.value))
      .toEqual(["debug", "info", "warn", "error"]);
    fireEvent.change(select, { target: { value: "warn" } });
    expect(onChange).toHaveBeenCalledWith("warn");
  });

  it("normalizes legacy boolean values and offers only true or false", () => {
    const onChange = vi.fn();
    render(<EnvValueInput type="bool" value="1" onChange={onChange} />);

    const select = screen.getByRole("combobox");
    expect((select as HTMLSelectElement).value).toBe("true");
    expect(Array.from(select.querySelectorAll("option")).map((option) => option.value))
      .toEqual(["true", "false"]);
    fireEvent.change(select, { target: { value: "false" } });
    expect(onChange).toHaveBeenCalledWith("false");
  });

  it("renders integers with declared bounds and unit steps", () => {
    render(<EnvValueInput type="int" value="4312" min={1} max={65535} onChange={vi.fn()} />);

    const input = screen.getByRole("spinbutton");
    expect(input.getAttribute("min")).toBe("1");
    expect(input.getAttribute("max")).toBe("65535");
    expect(input.getAttribute("step")).toBe("1");
  });
});