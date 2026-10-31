// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LogsPanel } from "./LogsPanel";

class LogSource {
  static instances: LogSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    LogSource.instances.push(this);
  }

  send(seq: number, text: string, level = "info") {
    this.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({ seq, ts: seq, level, text }),
    }));
  }
}

afterEach(() => {
  LogSource.instances = [];
  vi.unstubAllGlobals();
});

it("deduplicates replayed entries and resumes from the cursor without losing filters", () => {
  vi.stubGlobal("EventSource", LogSource);
  const { unmount } = render(<LogsPanel />);
  const first = LogSource.instances[0];
  act(() => {
    first.onopen?.();
    first.send(1, "first entry");
    first.send(1, "duplicate entry");
    first.send(2, "second entry", "warn");
  });
  expect(screen.queryByText("duplicate entry")).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("grep…"), { target: { value: "second" } });
  expect(screen.queryByText("first entry")).toBeNull();

  fireEvent.click(screen.getByTitle("Pause streaming"));
  expect(first.close).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTitle("Resume streaming"));
  expect(LogSource.instances[1].url).toBe("/api/v1/logs?since=2");
  expect(screen.getByText("second entry")).toBeTruthy();

  fireEvent.click(screen.getByTitle("Clear locally (server ring keeps the entries)"));
  fireEvent.click(screen.getByTitle("Pause streaming"));
  fireEvent.click(screen.getByTitle("Resume streaming"));
  const last = LogSource.instances[2];
  expect(last.url).toBe("/api/v1/logs");
  unmount();
  expect(last.close).toHaveBeenCalledTimes(1);
});
