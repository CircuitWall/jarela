import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  enqueueCommand,
  pollNextCommand,
  submitResult,
  handleBrowserPoll,
  handleBrowserResult,
  handleBrowserStatus,
  handleBrowserTabs,
  handleBrowserActivate,
  handleBrowserHistory,
  handleBrowserProgress,
  handleBrowserRetry,
  getExtensionStatus,
  _resetQueue,
  _resetExtensionStatus,
  _markExtensionSeen,
  _queueDepth,
  MAX_QUEUE_DEPTH,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  EXTENSION_LIVENESS_WINDOW_MS,
  type BrowserCommand,
  type ExtensionStatus,
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
  // The fast-fail in enqueueCommand requires a recent poll. Seed the
  // tracker so existing tests (which exercise the happy queueing path,
  // not the disconnect path) behave as if the extension just polled.
  _markExtensionSeen();
});

afterEach(() => {
  _resetQueue();
  _resetExtensionStatus();
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

  it("accepts first-class browser tab and batch-fill command shapes", async () => {
    enqueueCommand({ type: "tabs", include_unusable: true });
    enqueueCommand({ type: "activate_tab", tab_id: 7 });
    enqueueCommand({
      type: "fill_many",
      fields: [{ selector: "input[name=email]", value: "a@example.com" }],
      submit_selector: "button[type=submit]",
    });
    expect((await pollNextCommand(500))?.type).toBe("tabs");
    expect((await pollNextCommand(500))?.type).toBe("activate_tab");
    const picked = await pollNextCommand(500);
    expect(picked?.type).toBe("fill_many");
    if (picked?.type === "fill_many") {
      expect(picked.fields).toEqual([{ selector: "input[name=email]", value: "a@example.com" }]);
      expect(picked.submit_selector).toBe("button[type=submit]");
    }
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

  it("explains when a timed-out command was picked up by the extension", async () => {
    const { promise } = enqueueCommand(
      { type: "navigate", url: "https://example.com" },
      { timeout_ms: 50 },
    );
    const picked = await pollNextCommand(500);
    expect(picked?.type).toBe("navigate");
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/extension picked it up/);
      expect(result.error).toMatch(/approval prompt|stuck page load|blocked browser action/);
    }
  });
});

describe("browser app-facing handlers", () => {
  it("enqueues a tabs command and returns the extension result", async () => {
    const responseP = handleBrowserTabs(loopbackReq(
      "/api/v1/extension/browser/tabs?include_unusable=true",
      {},
      "GET",
    ));
    const cmd = await pollNextCommand(500);
    expect(cmd?.type).toBe("tabs");
    if (cmd?.type === "tabs") expect(cmd.include_unusable).toBe(true);
    submitResult({ cmd_id: cmd!.cmd_id, ok: true, data: { tabs: [{ tab_id: 7 }], total: 1 } });
    const res = await responseP;
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ tabs: [{ tab_id: 7 }], total: 1 });
  });

  it("parses include_unusable=false as false", async () => {
    const responseP = handleBrowserTabs(loopbackReq(
      "/api/v1/extension/browser/tabs?include_unusable=false",
      {},
      "GET",
    ));
    const cmd = await pollNextCommand(500);
    expect(cmd?.type).toBe("tabs");
    if (cmd?.type === "tabs") expect(cmd.include_unusable).toBe(false);
    submitResult({ cmd_id: cmd!.cmd_id, ok: true, data: { tabs: [], total: 0 } });
    const res = await responseP;
    expect(res.status).toBe(200);
  });

  it("enqueues an activate_tab command and returns the extension result", async () => {
    const responseP = handleBrowserActivate(loopbackReq(
      "/api/v1/extension/browser/activate",
      { tab_id: 7 },
    ));
    const cmd = await pollNextCommand(500);
    expect(cmd?.type).toBe("activate_tab");
    if (cmd?.type === "activate_tab") expect(cmd.tab_id).toBe(7);
    submitResult({ cmd_id: cmd!.cmd_id, ok: true, data: { tab_id: 7, focused: true } });
    const res = await responseP;
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ tab_id: 7, focused: true });
  });

  it("rejects invalid activate requests", async () => {
    const res = await handleBrowserActivate(loopbackReq(
      "/api/v1/extension/browser/activate",
      { tab_id: 0 },
    ));
    expect(res.status).toBe(400);
  });

  it("returns sanitized command history", async () => {
    const { cmd_id } = enqueueCommand({ type: "fill", selector: "input[name=password]", value: "secret" });
    submitResult({ cmd_id, ok: false, error: "no element matched" });
    const res = await handleBrowserHistory(loopbackReq(
      "/api/v1/extension/browser/history?limit=5",
      {},
      "GET",
    ));
    expect(res.status).toBe(200);
    const body = await res.json() as { commands: Array<Record<string, unknown>> };
    const row = body.commands.find((command) => command.cmd_id === cmd_id);
    expect(row).toBeDefined();
    expect(row?.retryable).toBe(false);
    expect(JSON.stringify(row)).not.toContain("secret");
  });

  it("records progress phases for command history and timeout messages", async () => {
    const { cmd_id, promise } = enqueueCommand(
      { type: "navigate", url: "https://example.com" },
      { timeout_ms: 50 },
    );
    await pollNextCommand(500);
    const progress = await handleBrowserProgress(loopbackReq(
      "/api/v1/extension/browser/progress",
      { cmd_id, phase: "waiting_for_load" },
    ));
    expect(progress.status).toBe(200);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Last known phase: waiting_for_load");
  });

  it("retries retryable commands", async () => {
    const original = enqueueCommand({ type: "snapshot", max_items: 10 });
    submitResult({ cmd_id: original.cmd_id, ok: false, error: "tab crashed" });

    const responseP = handleBrowserRetry(loopbackReq(
      "/api/v1/extension/browser/retry",
      { cmd_id: original.cmd_id },
    ));
    const retryCmd = await pollNextCommand(500);
    expect(retryCmd?.type).toBe("snapshot");
    if (retryCmd?.type === "snapshot") expect(retryCmd.max_items).toBe(10);
    submitResult({ cmd_id: retryCmd!.cmd_id, ok: true, data: { ok: true } });
    const res = await responseP;
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("refuses to retry non-retryable fill commands", async () => {
    const original = enqueueCommand({ type: "fill", selector: "input", value: "secret" });
    submitResult({ cmd_id: original.cmd_id, ok: false, error: "no element" });
    const res = await handleBrowserRetry(loopbackReq(
      "/api/v1/extension/browser/retry",
      { cmd_id: original.cmd_id },
    ));
    expect(res.status).toBe(409);
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

describe("extension connectivity tracking", () => {
  it("reports disconnected when no poll has ever arrived", () => {
    _resetExtensionStatus();
    const status = getExtensionStatus();
    expect(status.connected).toBe(false);
    expect(status.lastSeenMs).toBe(-1);
    expect(status.pollerWaiting).toBe(0);
  });

  it("reports connected after a recent poll", () => {
    _resetExtensionStatus();
    _markExtensionSeen();
    const status = getExtensionStatus();
    expect(status.connected).toBe(true);
    expect(status.lastSeenMs).toBeGreaterThanOrEqual(0);
    expect(status.lastSeenMs).toBeLessThan(1_000);
  });

  it("reports disconnected when the last poll is older than the liveness window", () => {
    _resetExtensionStatus();
    _markExtensionSeen(Date.now() - EXTENSION_LIVENESS_WINDOW_MS - 1_000);
    const status = getExtensionStatus();
    expect(status.connected).toBe(false);
  });

  it("counts an in-flight poller as connected even with no recent poll record", async () => {
    _resetExtensionStatus();
    const pollP = pollNextCommand(500);
    // While the long-poll is parked, the extension is provably alive.
    const status = getExtensionStatus();
    expect(status.connected).toBe(true);
    expect(status.pollerWaiting).toBeGreaterThanOrEqual(1);
    await pollP;
    expect(getExtensionStatus().pollerWaiting).toBe(0);
  });

  it("fast-fails enqueueCommand when the extension is offline", async () => {
    _resetExtensionStatus(); // no poller, no recent poll
    const start = Date.now();
    const { promise } = enqueueCommand(
      { type: "navigate", url: "https://example.com" },
      { timeout_ms: 30_000 },
    );
    const result = await promise;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // not 30s
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not connected/i);
      expect(result.error).toMatch(/toolbar icon/i);
    }
    // Nothing should have been queued.
    expect(_queueDepth()).toBe(0);
  });

  it("does NOT fast-fail when the extension just polled", async () => {
    _resetExtensionStatus();
    _markExtensionSeen();
    const { cmd_id } = enqueueCommand({ type: "click", selector: "#go" });
    expect(_queueDepth()).toBe(1);
    expect(cmd_id).toBeTruthy();
  });

  it("handleBrowserPoll updates lastSeenMs even when no command is delivered", async () => {
    _resetExtensionStatus();
    const before = getExtensionStatus();
    expect(before.connected).toBe(false);
    await handleBrowserPoll(loopbackReq("/api/v1/extension/browser/poll", { wait_ms: 50 }));
    const after = getExtensionStatus();
    expect(after.connected).toBe(true);
  });
});

describe("handleBrowserStatus HTTP handler", () => {
  it("rejects non-loopback callers with 403", async () => {
    const res = await handleBrowserStatus(externalReq("/api/v1/extension/browser/status", {}));
    expect(res.status).toBe(403);
  });

  it("returns the current ExtensionStatus on loopback", async () => {
    _resetExtensionStatus();
    _markExtensionSeen();
    const res = await handleBrowserStatus(loopbackReq("/api/v1/extension/browser/status", {}, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExtensionStatus;
    expect(body.connected).toBe(true);
    expect(body.pollerWaiting).toBe(0);
    expect(body.pendingCommands).toBe(0);
    expect(body.liveness_window_ms).toBe(EXTENSION_LIVENESS_WINDOW_MS);
  });

  it("reports disconnected before any poll has arrived", async () => {
    _resetExtensionStatus();
    const res = await handleBrowserStatus(loopbackReq("/api/v1/extension/browser/status", {}, "GET"));
    const body = (await res.json()) as ExtensionStatus;
    expect(body.connected).toBe(false);
    expect(body.lastSeenMs).toBe(-1);
  });
});
