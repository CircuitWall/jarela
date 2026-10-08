// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Dialog } from "./Dialog";
import { DialogFooter } from "./DialogFooter";
import { StickyActionBar } from "./StickyActionBar";
import { ConfirmHost } from "./ConfirmHost";
import { confirmAction } from "@/lib/ui/confirm";
import { useDirty, useDismissGuard } from "@/hooks/useDismissGuard";

function Editor({ onClose, onSave = vi.fn() }: { onClose: () => void; onSave?: () => void }) {
  const [value, setValue] = useState("a");
  const dirty = useDirty({ value });
  const requestClose = useDismissGuard({ dirty, onClose });
  return (
    <>
      <Dialog
        open
        onClose={requestClose}
        title="Edit"
        footer={<DialogFooter dirty={dirty} onCancel={requestClose} onDiscard={onClose} onSave={onSave} />}
      >
        <input aria-label="value" value={value} onChange={(e) => setValue(e.target.value)} />
      </Dialog>
      <ConfirmHost />
    </>
  );
}

describe("editor dismissal contract", () => {
  it("closes immediately on Escape, backdrop and Cancel while clean", () => {
    const onClose = vi.fn();
    render(<Editor onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("asks before discarding when dirty, from Escape, backdrop and X", async () => {
    const onClose = vi.fn();
    render(<Editor onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "b" } });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("Your edits have not been saved.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    // Escape with the prompt open only dismisses the prompt, not the editor.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Your edits have not been saved.")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("Discard in the footer closes without a second prompt and Save stays reachable", () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    render(<Editor onClose={onClose} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "b" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores dismissal while saving", () => {
    const onClose = vi.fn();
    function Busy() {
      const requestClose = useDismissGuard({ dirty: false, busy: true, onClose });
      return <button onClick={requestClose}>go</button>;
    }
    render(<Busy />);
    fireEvent.click(screen.getByText("go"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("confirmAction", () => {
  it("resolves true on confirm and false on cancel", async () => {
    render(<ConfirmHost />);
    let result!: Promise<boolean>;
    act(() => { result = confirmAction({ message: "Delete it?", destructive: true }); });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await expect(result).resolves.toBe(true);

    act(() => { result = confirmAction({ message: "Delete again?", destructive: true }); });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await expect(result).resolves.toBe(false);
  });
});

describe("StickyActionBar", () => {
  it("renders only when dirty or saving and wires Save/Discard", () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const { rerender, container } = render(<StickyActionBar dirty={false} onSave={onSave} onDiscard={onDiscard} />);
    expect(container.firstChild).toBeNull();
    rerender(<StickyActionBar dirty onSave={onSave} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
