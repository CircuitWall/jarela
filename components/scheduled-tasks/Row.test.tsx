// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Row } from "./Row";

afterEach(cleanup);

it("preserves the detail layout and treats labels as text", () => {
  const { container } = render(<Row label="<script>synthetic</script>"><span>Value</span></Row>);
  const row = container.firstElementChild!;
  expect(row.className).toBe("flex items-start gap-2");
  expect(row.children[0].className).toBe("w-20 shrink-0 text-fg-faint");
  expect(row.children[0].textContent).toBe("<script>synthetic</script>");
  expect(row.children[1].className).toBe("flex-1 min-w-0");
  expect(row.children[1].textContent).toBe("Value");
  expect(container.querySelector("script")).toBeNull();
});

it("preserves interactive children and updates labels without remounting them", () => {
  const onClick = vi.fn();
  const child = <input aria-label="Detail value" defaultValue="Original" onClick={onClick} />;
  const { rerender } = render(<Row label="Cron">{child}</Row>);
  const input = screen.getByRole("textbox", { name: "Detail value" });
  fireEvent.change(input, { target: { value: "Unsaved" } });
  rerender(<Row label="When">{child}</Row>);
  expect(screen.getByText("When")).toBeTruthy();
  expect(screen.getByDisplayValue("Unsaved")).toBe(input);
  fireEvent.click(input);
  expect(onClick).toHaveBeenCalledOnce();
});
