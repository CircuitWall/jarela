// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useIconFile } from "./useIconFile";

let readers: FileReader[];

beforeEach(() => {
  readers = [];
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
    Object.defineProperty(this, "readyState", { value: FileReader.LOADING, configurable: true });
    readers.push(this);
  });
  vi.spyOn(FileReader.prototype, "abort").mockImplementation(function (this: FileReader) {
    Object.defineProperty(this, "readyState", { value: FileReader.DONE, configurable: true });
    this.dispatchEvent(new ProgressEvent("abort"));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Picker({ onChange, validateFile }: {
  onChange?: (icon: string | null) => void;
  validateFile?: (file: File) => string | null;
}) {
  const [icon, updateIcon] = useState<string | null>("saved-icon");
  const { handleIconFile, setIcon, iconError } = useIconFile(onChange ?? updateIcon, validateFile);
  return (
    <>
      <input aria-label="Icon file" type="file" onChange={handleIconFile} />
      <button onClick={() => setIcon(null)}>Remove icon</button>
      <output>{icon ?? "no-icon"}</output>
      {iconError && <p role="alert">{iconError}</p>}
    </>
  );
}

function choose(file = new File(["synthetic"], "avatar.png")) {
  fireEvent.change(screen.getByLabelText("Icon file"), { target: { files: [file] } });
}

function finish(reader: FileReader, result: string | ArrayBuffer | null) {
  act(() => {
    Object.defineProperty(reader, "readyState", { value: FileReader.DONE, configurable: true });
    Object.defineProperty(reader, "result", { value: result, configurable: true });
    reader.dispatchEvent(new ProgressEvent("load"));
  });
}

it("keeps the saved icon on an empty selection", () => {
  render(<Picker />);
  fireEvent.change(screen.getByLabelText("Icon file"), { target: { files: [] } });
  expect(readers).toHaveLength(0);
  expect(screen.getByText("saved-icon")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("aborts a superseded read and refuses its late result", () => {
  render(<Picker />);
  choose();
  choose(new File(["new"], "new.png"));
  expect(FileReader.prototype.abort).toHaveBeenCalledOnce();
  expect(readers[0].onload).toBeNull();
  finish(readers[1], "data:image/png;base64,new");
  finish(readers[0], "data:image/png;base64,old");
  expect(screen.getByText("data:image/png;base64,new")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("cancels a pending read when the icon is removed", () => {
  render(<Picker />);
  choose();
  fireEvent.click(screen.getByRole("button", { name: "Remove icon" }));
  finish(readers[0], "data:image/png;base64,late");
  expect(FileReader.prototype.abort).toHaveBeenCalledOnce();
  expect(screen.getByText("no-icon")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("aborts and detaches reads on unmount without updating or reporting an error", () => {
  const onChange = vi.fn();
  const { unmount } = render(<Picker onChange={onChange} />);
  choose();
  unmount();
  expect(FileReader.prototype.abort).toHaveBeenCalledOnce();
  expect(readers[0].onload).toBeNull();
  expect(readers[0].onerror).toBeNull();
  expect(readers[0].onabort).toBeNull();
  finish(readers[0], "data:image/png;base64,late");
  expect(onChange).not.toHaveBeenCalled();
});

it.each(["error", "abort"])("reports unexpected %s and permits retrying the same file", (event) => {
  render(<Picker />);
  const file = new File(["synthetic"], "avatar.png");
  choose(file);
  act(() => readers[0].dispatchEvent(new ProgressEvent(event)));
  expect(screen.getByRole("alert").textContent).toContain("Could not read that image");
  expect(screen.getByText("saved-icon")).toBeTruthy();
  choose(file);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(readers).toHaveLength(2);
  finish(readers[1], "data:image/png;base64,retry");
  expect(screen.getByText("data:image/png;base64,retry")).toBeTruthy();
});

it.each([null, new ArrayBuffer(4)])("refuses non-string results instead of coercing them", (result) => {
  render(<Picker />);
  choose();
  finish(readers[0], result);
  expect(screen.getByRole("alert").textContent).toContain("Could not read that image");
  expect(screen.getByText("saved-icon")).toBeTruthy();
});

it("surfaces synchronous read failures", () => {
  vi.mocked(FileReader.prototype.readAsDataURL).mockImplementationOnce(() => {
    throw new DOMException("Synthetic read failure", "NotReadableError");
  });
  render(<Picker />);
  choose();
  expect(screen.getByRole("alert").textContent).toContain("Could not read that image");
  expect(screen.getByText("saved-icon")).toBeTruthy();
});

it("keeps validation at the caller boundary and cancels a previous read on rejection", () => {
  render(<Picker validateFile={(file) => file.size > 3 ? "Image is too large." : null} />);
  choose(new File(["ok"], "small.png"));
  choose();
  expect(readers).toHaveLength(1);
  expect(FileReader.prototype.abort).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert").textContent).toBe("Image is too large.");
  finish(readers[0], "data:image/png;base64,late");
  expect(screen.getByText("saved-icon")).toBeTruthy();
});

it("uses the latest committed callback when a read finishes after rerender", () => {
  const previous = vi.fn();
  const next = vi.fn();
  const { rerender } = render(<Picker onChange={previous} />);
  choose();
  rerender(<Picker onChange={next} />);
  finish(readers[0], "data:image/png;base64,new");
  expect(previous).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledWith("data:image/png;base64,new");
});
