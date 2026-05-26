import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-triggers-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  registerTriggerHandler,
  listTriggerHandlers,
  runTriggerTick,
} = await import("./index");
const { __resetTriggerRegistry } = await import("./registry");

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  __resetTriggerRegistry();
});

describe("trigger registry (ADR-0025)", () => {
  it("registers handlers and lists them back", () => {
    expect(listTriggerHandlers()).toHaveLength(0);
    registerTriggerHandler({
      kind: "test_kind",
      getDueFirings: () => [],
      markFired: () => {},
    });
    expect(listTriggerHandlers().map((h) => h.kind)).toEqual(["test_kind"]);
  });

  it("replaces a handler registered under the same kind", () => {
    registerTriggerHandler({
      kind: "test_kind",
      getDueFirings: () => [],
      markFired: () => {},
    });
    let seenSentinel = "";
    registerTriggerHandler({
      kind: "test_kind",
      getDueFirings: () => [],
      markFired: () => { seenSentinel = "second"; },
    });
    expect(listTriggerHandlers()).toHaveLength(1);
    // Force a firing through the second handler to confirm the replacement
    // is what's actually wired in.
    listTriggerHandlers()[0].markFired(
      { id: "x", kind: "test_kind", mode: "prompt", agentId: "a", prompt: "p" },
      { status: "done", preview: "", threadId: "" },
    );
    expect(seenSentinel).toBe("second");
  });
});

describe("runTriggerTick (ADR-0025)", () => {
  it("calls markFired with status='error' when the firing references an unknown agent", async () => {
    const seen: Array<{ id: string; status: string; error: string | undefined }> = [];
    registerTriggerHandler({
      kind: "test_kind",
      getDueFirings: () => [
        {
          id: "fire-1",
          kind: "test_kind",
          mode: "prompt",
          agentId: "agent-does-not-exist",
          prompt: "hi",
        },
      ],
      markFired: (firing, outcome) => {
        seen.push({ id: firing.id, status: outcome.status, error: outcome.error });
      },
    });
    await runTriggerTick();
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe("fire-1");
    expect(seen[0].status).toBe("error");
    expect(seen[0].error).toMatch(/agent-does-not-exist/);
  });

  it("swallows handler getDueFirings exceptions and moves on to the next handler", async () => {
    let okHandlerRan = false;
    registerTriggerHandler({
      kind: "broken",
      getDueFirings: () => { throw new Error("boom"); },
      markFired: () => {},
    });
    registerTriggerHandler({
      kind: "ok",
      getDueFirings: () => { okHandlerRan = true; return []; },
      markFired: () => {},
    });
    await expect(runTriggerTick()).resolves.toBeUndefined();
    expect(okHandlerRan).toBe(true);
  });

});
