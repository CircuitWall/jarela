import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  enqueueCommand,
  pollNextCommand,
  submitResult,
  handleBrowserPoll,
  handleBrowserResult,
  _resetQueue,
  _queueDepth,
  MAX_QUEUE_DEPTH,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  type BrowserCommand,
} from "./browser-control";

function loopbackReq(path: string, body: unknown, method: "GET" | "POST" = "POST"): Request {
  return new Request(`http://localhost:4312${path}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost:4312" },
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function externalReq(path: string, body: unknown): Request {
  return new Request(`http://evil.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "evil.com" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  _resetQueue();
});

afterEach(() => {
  _resetQueue();
});

describe("enqueueCommand / pollNextCommand", () => {
  it("delivers an already-queued command to the next poller", async () => {
    const { cmd_id } = enqueueCommand({ type: "navigate", url: "https://example.com" });
    expect(_queueDepth()).toBe(1);
    const picked = await pollNextCommand(500);
    expect(picked).not.toBeNull();
    expect(picked!.cmd_id).toBe(cmd_id);
    expect(picked!.type).toBe("navigate");
  });

  it("blocks the poller until a command is enqueued", async () => {
    const pollP = pollNextCommand(2000);
    enqueueCommand({ type: "click", selector: "#go" });
    const picked = await pollP;
    expect(picked).not.toBeNull();
    expect(picked!.type).toBe("click");
  });

  it("resolves with null when no command arrives within the wait window", async () => {
    const picked = await pollNextCommand(150);
    expect(picked).toBeNull();
  });

  it("dispatches commands FIFO across multiple pollers", async () => {
    const { cmd_id: c1 } = enqueueCommand({ type: "click", selector: "#a" });
    const { cmd_id: c2 } = enqueueCommand({ type: "click", selector: "#b" });
    const p1 = await pollNextCommand(500);
    const p2 = await pollNextCommand(500);
    expect(p1?.cmd_id).toBe(c1);
    expect(p2?.cmd_id).toBe(c2);
  });

  it("clamps timeout_ms above MAX_COMMAND_TIMEOUT_MS", async () => {
    const result = enqueueCommand(
      { type: "navigate", url: "https://example.com" },
      { timeout_ms: MAX_COMMAND_TIMEOUT_MS * 10 },
    );
    const picked = await pollNextCommand(500);
    expect(picked).not.toBeNull();
    expect(picked!.timeout_ms).toBe(MAX_COMMAND_TIMEOUT_MS);
    // Settle the awaiting promise to clean up.
    submitResult({ cmd_id: result.cmd_id, ok: true, data: null });
    await result.promise;
  });

  it("refuses to enqueue past MAX_QUEUE_DEPTH", async () => {
    const handles: Array<{ cmd_id: string; promise: Promise<unknown> }> = [];
    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
      handles.push(enqueueCommand({ type: "click", selector: `#x${i}` }));
    }
    const overflow = enqueueCommand({ type: "click", selector: "#overflow" });
    const result = await overflow.promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/queue full/);
    // Drain queued commands to release any pending timers.
    for (const h of handles) submitResult({ cmd_id: h.cmd_id, ok: true, data: null });
    await Promise.all(handles.map((h) => h.promise));
  });
});

describe("submitResult", () => {
  it("resolves the enqueued promise with the matching outcome", async () => {
    const { cmd_id, promise } = enqueueCommand({ type: "extract", selector: "h1", format: "text" });
    submitResult({ cmd_id, ok: true, data: { content: "hi" } });
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ content: "hi" });
  });

  it("propagates errors when ok=false", async () => {
    const { cmd_id, promise } = enqueueCommand({ type: "click", selector: "#missing" });
    submitResult({ cmd_id, ok: false, error: "no element matched" });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("no element matched");
  });

  it("reports matched=false for unknown cmd_id", () => {
    const r = submitResult({ cmd_id: "nope", ok: true, data: null });
    expect(r.matched).toBe(false);
  });

  it("times out the agent promise when the extension never replies", async () => {
    const { promise } = enqueueCommand(
      { type: "click", selector: "#x" },
      { timeout_ms: 50 },
    );
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out/);
  });
});

describe("handleBrowserPoll HTTP handler", () => {
  it("rejects non-loopback callers with 403", async () => {
    const res = await handleBrowserPoll(externalReq("/api/v1/extension/browser/poll", {}));
    expect(res.status).toBe(403);
  });

  it("returns command:null on idle expiry", async () => {
    const res = await handleBrowserPoll(loopbackReq("/api/v1/extension/browser/poll", { wait_ms: 100 }));
    const body = (await res.json()) as { ok: boolean; command: BrowserCommand | null };
    expect(body.ok).toBe(true);
    expect(body.command).toBeNull();
  });

  it("returns the queued command immediately when one is present", async () => {
    enqueueCommand({ type: "navigate", url: "https://example.com" });
    const res = await handleBrowserPoll(loopbackReq("/api/v1/extension/browser/poll", { wait_ms: 200 }));
    const body = (await res.json()) as { ok: boolean; command: BrowserCommand | null };
    expect(body.command).not.toBeNull();
    expect(body.command!.type).toBe("navigate");
  });

  it("tolerates an empty body / wrong shape and uses the default wait", async () => {
    // Empty body → JSON parse fails → handler falls back to defaults.
    // We just verify it doesn't 500. Use a synthetic short wait by enqueueing first.
    enqueueCommand({ type: "click", selector: "#a" });
    const res = await handleBrowserPoll(loopbackReq("/api/v1/extension/browser/poll", "", "POST"));
    expect(res.status).toBe(200);
  });
});

describe("handleBrowserResult HTTP handler", () => {
  it("rejects non-loopback callers with 403", async () => {
    const res = await handleBrowserResult(externalReq("/api/v1/extension/browser/result", { cmd_id: "x", ok: true }));
    expect(res.status).toBe(403);
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await handleBrowserResult(loopbackReq("/api/v1/extension/browser/result", "not json"));
    expect(res.status).toBe(400);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await handleBrowserResult(loopbackReq("/api/v1/extension/browser/result", { ok: true }));
    expect(res.status).toBe(400);
  });

  it("delivers a successful result to the awaiting tool", async () => {
    const { cmd_id, promise } = enqueueCommand({ type: "extract", selector: "h1", format: "text" });
    const res = await handleBrowserResult(
      loopbackReq("/api/v1/extension/browser/result", { cmd_id, ok: true, data: { content: "hi" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; matched: boolean };
    expect(body.matched).toBe(true);
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ content: "hi" });
  });

  it("returns matched=false when cmd_id is unknown", async () => {
    const res = await handleBrowserResult(
      loopbackReq("/api/v1/extension/browser/result", { cmd_id: "nope", ok: true }),
    );
    const body = (await res.json()) as { matched: boolean };
    expect(body.matched).toBe(false);
  });
});

describe("constants surface", () => {
  it("DEFAULT_COMMAND_TIMEOUT_MS is sensible", () => {
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBeGreaterThan(1_000);
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(MAX_COMMAND_TIMEOUT_MS);
  });
});

describe("snapshot command", () => {
  it("enqueues a snapshot command with no required fields", async () => {
    const { cmd_id } = enqueueCommand({ type: "snapshot" });
    const picked = await pollNextCommand(500);
    expect(picked?.cmd_id).toBe(cmd_id);
    expect(picked?.type).toBe("snapshot");
  });

  it("preserves optional max_items / include_hidden through the queue", async () => {
    const { cmd_id } = enqueueCommand({ type: "snapshot", max_items: 25, include_hidden: true });
    const picked = await pollNextCommand(500);
    expect(picked?.cmd_id).toBe(cmd_id);
    if (picked?.type !== "snapshot") throw new Error("expected snapshot");
    expect(picked.max_items).toBe(25);
    expect(picked.include_hidden).toBe(true);
  });
});
