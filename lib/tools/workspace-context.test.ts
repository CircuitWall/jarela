import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  currentWorkspace,
  setWorkspace,
  clearWorkspace,
  _resetWorkspaceContext,
  reportToolProgress,
} from "./workspace-context";

beforeEach(() => {
  _resetWorkspaceContext();
});

describe("workspace-context", () => {
  it("returns undefined when nothing is set", () => {
    expect(currentWorkspace()).toBeUndefined();
    expect(currentWorkspace({ configurable: { thread_id: "x" } })).toBeUndefined();
  });

  it("set/get round-trip in the default slot when no thread_id is supplied", () => {
    setWorkspace({ root: "/tmp/a", scoped: false, opened_at: 1 });
    expect(currentWorkspace()).toEqual({ root: "/tmp/a", scoped: false, opened_at: 1 });
  });

  it("isolates workspaces per thread_id", () => {
    setWorkspace({ root: "/tmp/a", scoped: false, opened_at: 1 }, { configurable: { thread_id: "alpha" } });
    setWorkspace({ root: "/tmp/b", scoped: true, opened_at: 2 }, { configurable: { thread_id: "beta" } });

    expect(currentWorkspace({ configurable: { thread_id: "alpha" } })?.root).toBe("/tmp/a");
    expect(currentWorkspace({ configurable: { thread_id: "beta" } })?.root).toBe("/tmp/b");
    expect(currentWorkspace({ configurable: { thread_id: "beta" } })?.scoped).toBe(true);
    // Default slot is independent of named threads.
    expect(currentWorkspace()).toBeUndefined();
  });

  it("treats an empty-string thread_id as the default slot", () => {
    setWorkspace({ root: "/tmp/def", scoped: false, opened_at: 0 });
    expect(currentWorkspace({ configurable: { thread_id: "" } })?.root).toBe("/tmp/def");
  });

  it("treats a non-string thread_id as the default slot", () => {
    setWorkspace({ root: "/tmp/def", scoped: false, opened_at: 0 });
    // @ts-expect-error: intentionally passing a non-string to exercise the guard
    expect(currentWorkspace({ configurable: { thread_id: 42 } })?.root).toBe("/tmp/def");
  });

  it("setWorkspace overwrites the existing entry in the same slot", () => {
    setWorkspace({ root: "/tmp/old", scoped: false, opened_at: 1 });
    setWorkspace({ root: "/tmp/new", scoped: true, opened_at: 2 });
    expect(currentWorkspace()).toEqual({ root: "/tmp/new", scoped: true, opened_at: 2 });
  });

  it("clearWorkspace returns true when an entry existed and false otherwise", () => {
    setWorkspace({ root: "/tmp/a", scoped: false, opened_at: 1 }, { configurable: { thread_id: "t1" } });
    expect(clearWorkspace({ configurable: { thread_id: "t1" } })).toBe(true);
    expect(clearWorkspace({ configurable: { thread_id: "t1" } })).toBe(false);
    expect(currentWorkspace({ configurable: { thread_id: "t1" } })).toBeUndefined();
  });

  it("clearing one thread's workspace leaves other threads intact", () => {
    setWorkspace({ root: "/tmp/a", scoped: false, opened_at: 1 }, { configurable: { thread_id: "t1" } });
    setWorkspace({ root: "/tmp/b", scoped: false, opened_at: 2 }, { configurable: { thread_id: "t2" } });
    clearWorkspace({ configurable: { thread_id: "t1" } });
    expect(currentWorkspace({ configurable: { thread_id: "t2" } })?.root).toBe("/tmp/b");
  });

  it("_resetWorkspaceContext wipes every slot", () => {
    setWorkspace({ root: "/tmp/a", scoped: false, opened_at: 1 });
    setWorkspace({ root: "/tmp/b", scoped: false, opened_at: 2 }, { configurable: { thread_id: "t1" } });
    _resetWorkspaceContext();
    expect(currentWorkspace()).toBeUndefined();
    expect(currentWorkspace({ configurable: { thread_id: "t1" } })).toBeUndefined();
  });
});

describe("reportToolProgress", () => {
  it("calls config.writer with { id, name, text }", () => {
    const writer = vi.fn();
    reportToolProgress({ writer, toolCallId: "call-1" }, "claude_delegate", "→ Read: foo.ts");
    expect(writer).toHaveBeenCalledWith({ id: "call-1", name: "claude_delegate", text: "→ Read: foo.ts" });
  });

  it("defaults id to an empty string when toolCallId is missing", () => {
    const writer = vi.fn();
    reportToolProgress({ writer }, "claude_delegate", "step");
    expect(writer).toHaveBeenCalledWith({ id: "", name: "claude_delegate", text: "step" });
  });

  it("is a no-op when config or config.writer is missing", () => {
    expect(() => reportToolProgress(undefined, "claude_delegate", "step")).not.toThrow();
    expect(() => reportToolProgress({}, "claude_delegate", "step")).not.toThrow();
  });
});
