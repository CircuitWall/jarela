import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-watchers-route-"));
const originalDbDir = process.env.JARELA_DB_DIR;
process.env.JARELA_DB_DIR = tmpRoot;

vi.mock("@/lib/scheduler", () => ({ startScheduler: vi.fn() }));

const { POST } = await import("./route");
const { registerTools, _resetRegistry } = await import("@/lib/tools/runtime/registry");
const { listWatchers, deleteWatcher } = await import("@/lib/stores/watchers");

afterAll(() => {
  if (originalDbDir === undefined) delete process.env.JARELA_DB_DIR;
  else process.env.JARELA_DB_DIR = originalDbDir;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function post(body: unknown) {
  return POST(new NextRequest("http://localhost/api/v1/watchers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

const fake = (name: string) => tool(async () => "ok", { name, description: name, schema: z.object({}).passthrough() });

describe("POST /api/v1/watchers", () => {
  beforeEach(() => {
    _resetRegistry();
    registerTools("Files", "read", [fake("route_read")]);
    registerTools("Files", "write", [fake("route_write")]);
    for (const w of listWatchers()) deleteWatcher(w.id);
  });

  it("creates a watcher over a read-only tool", async () => {
    const res = await post({ agent_id: "a", label: "ok", tool: "route_read", every_seconds: 60 });
    expect(res.status).toBe(201);
    expect(listWatchers()).toHaveLength(1);
  });

  it("rejects a side-effecting tool without persisting it", async () => {
    const res = await post({ agent_id: "a", label: "unsafe", tool: "route_write", every_seconds: 60 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/read-only/);
    expect(listWatchers()).toHaveLength(0);
  });
});
