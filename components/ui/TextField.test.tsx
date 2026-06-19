// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { createRef } from "react";
import { TextInput, TextArea, FIELD_CLASS } from "./TextField";

describe("FIELD_CLASS", () => {
  it("bakes the disabled opacity affordance so every field stays consistent", () => {
    expect(FIELD_CLASS).toContain("disabled:opacity-50");
  });

  it("targets bg-surface-3 and the accent focus ring", () => {
    expect(FIELD_CLASS).toContain("bg-surface-3");
    expect(FIELD_CLASS).toContain("focus:ring-accent");
  });
});

describe("TextInput", () => {
  it("renders an <input> with the shared FIELD_CLASS baseline", () => {
    const { container } = render(<TextInput placeholder="email" />);
    const input = container.querySelector("input")!;
    expect(input).not.toBeNull();
    expect(input.className).toContain("bg-surface-3");
    expect(input.className).toContain("focus:ring-accent");
  });

  it("appends caller className after the baseline so caller wins on conflicts", () => {
    const { container } = render(<TextInput className="extra-marker" />);
    const input = container.querySelector("input")!;
    const cls = input.className;
    expect(cls.indexOf("extra-marker")).toBeGreaterThan(cls.indexOf("bg-surface-3"));
  });

  it("passes through native input attributes", () => {
    const { container } = render(
      <TextInput type="email" placeholder="you@example.com" defaultValue="seed" />,
    );
    const input = container.querySelector("input")!;
    expect(input.getAttribute("type")).toBe("email");
    expect(input.getAttribute("placeholder")).toBe("you@example.com");
    expect(input.value).toBe("seed");
  });

  it("forwards refs to the underlying input element", () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextInput ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });
});

describe("TextArea", () => {
  it("renders a <textarea> with the shared FIELD_CLASS baseline", () => {
    const { container } = render(<TextArea placeholder="notes" />);
    const ta = container.querySelector("textarea")!;
    expect(ta).not.toBeNull();
    expect(ta.className).toContain("bg-surface-3");
  });

  it("appends caller className after the baseline", () => {
    const { container } = render(<TextArea className="extra-marker" />);
    const ta = container.querySelector("textarea")!;
    const cls = ta.className;
    expect(cls.indexOf("extra-marker")).toBeGreaterThan(cls.indexOf("bg-surface-3"));
  });

  it("forwards refs to the underlying textarea element", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<TextArea ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });
});
