import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const root = mkdtempSync(join(tmpdir(), "jarela-run-reconnect-"));
process.env.JARELA_DB_DIR = root;
vi.mock("@/lib/scheduler", () => ({ startScheduler: () => {} }));

const { GET } = await import("./route");
const { startRun, broadcast, finishRun } = await import("@/lib/agents/run-registry");
const { closeDb } = await import("@/lib/db");

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

const request = (threadId: string, cursor?: string, query = "") =>
  GET(new NextRequest(`http://localhost/api/v1/threads/${threadId}/run${query}`, {
    headers: cursor ? { "Last-Event-ID": cursor } : {},
  }), { params: Promise.resolve({ thread_id: threadId }) });

describe("run SSE reconnect cursors", () => {
  it("emits run-scoped event IDs and resumes after the browser's last event", async () => {
    const run = startRun("route-resume", null);
    broadcast(run, { type: "text_delta", data: { delta: "Already displayed." } });
    const response = await request(run.thread_id);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain(`id: ${run.id}:1\n`);
    await reader.cancel();

    broadcast(run, { type: "text_delta", data: { delta: "Only new text." } });
    broadcast(run, { type: "done", data: {} });
    finishRun(run, "done");
    const resumed = await (await request(run.thread_id, `${run.id}:1`)).text();
    expect(resumed).not.toContain("Already displayed.");
    expect(resumed).toContain(`id: ${run.id}:2\n`);
    expect(resumed).toContain("Only new text.");
    expect(resumed).toContain('"type":"done"');
  });

  it("keeps cursor sequencing consistent when a subscriber filters thinking", async () => {
    const run = startRun("route-filtered-resume", null);
    broadcast(run, { type: "thinking_delta", data: { delta: "private reasoning" } });
    broadcast(run, { type: "text_delta", data: { delta: "Visible." } });
    broadcast(run, { type: "done", data: {} });
    finishRun(run, "done");
    const wire = await (await request(run.thread_id, `${run.id}:1`, "?show_thinking=false")).text();
    expect(wire).not.toContain("private reasoning");
    expect(wire).toContain(`id: ${run.id}:2\n`);
    expect(wire).toContain(`id: ${run.id}:3\n`);
  });

  it("restores a snapshot for an invalid cursor and stays subscribed until the run actually ends", async () => {
    const run = startRun("route-stale-cursor", null);
    broadcast(run, { type: "text_delta", data: { delta: "Do not duplicate." } });
    try {
      const reader = (await request(run.thread_id, "older-run:1")).body!.getReader();
      const wire = new TextDecoder().decode((await reader.read()).value);
      expect(wire).toContain('"type":"stream_snapshot"');
      expect(wire).toContain('"text":"Do not duplicate."');
      expect(wire).not.toContain('"type":"error"');
      expect(run.subscribers.size).toBe(1);
      broadcast(run, { type: "text_delta", data: { delta: " Still running." } });
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(" Still running.");
      broadcast(run, { type: "done", data: {} });
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"done"');
      await reader.cancel();
    } finally {
      finishRun(run, "done");
    }
  });

  it("ends a completed snapshot recovery with the recorded terminal event", async () => {
    const run = startRun("route-completed-snapshot", null);
    broadcast(run, { type: "text_delta", data: { delta: "Saved response." } });
    broadcast(run, { type: "done", data: {} });
    finishRun(run, "done");
    const wire = await (await request(run.thread_id, "older-run:1")).text();
    expect(wire).toContain('"type":"stream_snapshot"');
    expect(wire).toContain('"type":"done"');
  });

  it("recovers full text after buffer eviction while preserving filters and terminal failures", async () => {
    const run = startRun("route-evicted-snapshot", null);
    broadcast(run, { type: "text_delta", data: { delta: "Earlier text." } });
    run.events.shift();
    broadcast(run, { type: "text_delta", data: { delta: " Later text." } });
    broadcast(run, { type: "tool_call", data: { id: "c1", name: "file_write", arguments: {} } });
    broadcast(run, { type: "error", data: { code: "run_idle_timeout", message: "Run timed out." } });
    broadcast(run, { type: "done", data: {} });
    finishRun(run, "error");
    const wire = await (await request(run.thread_id, undefined, "?show_tools=false")).text();
    expect(wire).toContain('"text":"Earlier text. Later text."');
    expect(wire).toContain('"tool_events":[]');
    expect(wire).toContain('"code":"run_idle_timeout"');
    expect(wire).not.toContain('"type":"done"');
  });
});
