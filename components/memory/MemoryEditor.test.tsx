// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryEditor } from "./MemoryEditor";

describe("MemoryEditor", () => {
  it("opens a wide dialog with a tall JSON editor", () => {
    render(<MemoryEditor onSave={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByRole("dialog").className).toContain("max-w-2xl");
    expect(screen.getByPlaceholderText('{"key": "value"}').className).toContain("h-[50vh]");
  });

  it("trims new identifiers and preserves a JSON null value", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<MemoryEditor onSave={onSave} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: " facts " } });
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: " nullable " } });
    fireEvent.change(screen.getByLabelText("Value (JSON)"), { target: { value: "null" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("facts", "nullable", null));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ["", "key", "{}", "Namespace and key are required"],
    ["facts", " ", "{}", "Namespace and key are required"],
    ["facts", "key", "{broken", "Value must be valid JSON"],
  ])("rejects invalid input without saving (%s, %s, %s)", async (namespace, key, value, message) => {
    const onSave = vi.fn();
    render(<MemoryEditor onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: namespace } });
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: key } });
    fireEvent.change(screen.getByLabelText("Value (JSON)"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("retains the edited value and shows a failed save without closing", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockRejectedValue(new Error("Synthetic save failed"));
    render(<MemoryEditor item={{ namespace: "facts", key: "existing", value: 0, created_at: 1, updated_at: 1 }} onSave={onSave} onClose={onClose} />);
    expect(screen.getByLabelText("Namespace")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Key")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Value (JSON)"), { target: { value: "false" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Synthetic save failed");
    expect(screen.getByLabelText("Value (JSON)")).toHaveProperty("value", "false");
    expect(onClose).not.toHaveBeenCalled();
  });
});
