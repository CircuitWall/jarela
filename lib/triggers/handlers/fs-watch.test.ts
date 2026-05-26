import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ScriptFiring, TriggerFiring } from "../types";

const {
  fsWatchHandler,
  __resetFsWatchState,
  __pushEventForTest,
  FS_WATCH_KIND,
} = await import("./fs-watch");

beforeEach(() => {
  vi.useFakeTimers();
  __resetFsWatchState();
});

afterEach(() => {
  vi.useRealTimers();
  __resetFsWatchState();
});

async function dueFirings(): Promise<TriggerFiring[]> {
  return Promise.resolve(fsWatchHandler.getDueFirings(new Date()));
}

function expectScript(f: TriggerFiring): ScriptFiring {
  if (f.mode !== "script") throw new Error("expected script firing");
  return f;
}

describe("fs-watch handler (ADR-0028)", () => {
  it("debounces events into a single firing per (source, abs)", async () => {
    __pushEventForTest("src-1", "/root", "notes.md");
    __pushEventForTest("src-1", "/root", "notes.md");
    __pushEventForTest("src-1", "/root", "notes.md");

    expect(await dueFirings()).toHaveLength(0);

    vi.advanceTimersByTime(600);

    const firings = await dueFirings();
    expect(firings).toHaveLength(1);
    const f = expectScript(firings[0]);
    expect(f.kind).toBe(FS_WATCH_KIND);
    expect(f.script).toBe("documents.reindex_local_file");
    expect(f.args).toMatchObject({ source_id: "src-1" });
    expect(String(f.args!.abs)).toContain("notes.md");
  });

  it("emits one firing per distinct (source, abs)", async () => {
    __pushEventForTest("src-1", "/root", "a.md");
    __pushEventForTest("src-1", "/root", "b.md");
    __pushEventForTest("src-2", "/other", "c.md");
    vi.advanceTimersByTime(600);

    expect(await dueFirings()).toHaveLength(3);
  });

  it("drops events for skip-dirs", async () => {
    __pushEventForTest("src-1", "/root", "node_modules/foo/index.js");
    __pushEventForTest("src-1", "/root", ".git/HEAD");
    __pushEventForTest("src-1", "/root", "dist/bundle.js");
    vi.advanceTimersByTime(600);

    expect(await dueFirings()).toHaveLength(0);
  });

  it("drops events for disallowed extensions", async () => {
    __pushEventForTest("src-1", "/root", "image.png");
    __pushEventForTest("src-1", "/root", "video.mp4");
    __pushEventForTest("src-1", "/root", "archive.zip");
    vi.advanceTimersByTime(600);

    expect(await dueFirings()).toHaveLength(0);
  });

  it("drops events from dot-prefixed parent directories", async () => {
    __pushEventForTest("src-1", "/root", ".vscode/settings.json");
    __pushEventForTest("src-1", "/root", ".cache/x.txt");
    vi.advanceTimersByTime(600);

    expect(await dueFirings()).toHaveLength(0);
  });

  it("draining clears pending so the same firing isn't re-emitted", async () => {
    __pushEventForTest("src-1", "/root", "notes.md");
    vi.advanceTimersByTime(600);
    expect(await dueFirings()).toHaveLength(1);
    expect(await dueFirings()).toHaveLength(0);
  });

  it("a second event after a drain enqueues a fresh firing", async () => {
    __pushEventForTest("src-1", "/root", "notes.md");
    vi.advanceTimersByTime(600);
    expect(await dueFirings()).toHaveLength(1);

    __pushEventForTest("src-1", "/root", "notes.md");
    vi.advanceTimersByTime(600);
    expect(await dueFirings()).toHaveLength(1);
  });

  it("markFired is a noop (no extra bookkeeping)", () => {
    expect(() =>
      fsWatchHandler.markFired(
        {
          id: "x",
          kind: FS_WATCH_KIND,
          mode: "script",
          script: "documents.reindex_local_file",
          args: { source_id: "src-1", abs: "/root/notes.md" },
        },
        { status: "done", preview: "", threadId: "" },
      ),
    ).not.toThrow();
  });
});
