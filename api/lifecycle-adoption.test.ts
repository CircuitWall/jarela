import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-lifecycle-adoption-api-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("@/lib/db");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { GET, POST } = await import("@/app/api/v1/lifecycle/adoption/route");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  getDb().exec("DELETE FROM memory_store WHERE namespace='app-lifecycle'");
  getDb().exec("DELETE FROM agent_configs");
});

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/lifecycle/adoption", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("/api/v1/lifecycle/adoption", () => {
  it("returns blocked status when no default agent exists", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("blocked_no_default_agent");
    expect(body.default_agent_id).toBeNull();
  });

  it("returns first-adoption baseline when the default agent exists", async () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });

    const res = GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.is_first_adoption).toBe(true);
    expect(body.status).toBe("pending");
    expect(body.default_agent_name).toBe("Assistant");
    expect(body.checklist.length).toBeGreaterThan(0);
  });

  it("marks the current adoption done", async () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });

    const res = await POST(post({ action: "mark_done" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("done");
    expect(body.completed_at).toBeTruthy();
    expect(body.checklist.every((item: { status: string }) => item.status === "done")).toBe(true);
  });

  it("starts adoption by returning the default agent thread and prompt", async () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });

    const res = await POST(post({ action: "start" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("running");
    expect(body.phase).toBe("impact_radius");
    expect(body.adoption_thread_id).toBeTruthy();
    expect(body.adoption_prompt).toContain("Phase 1");
    expect(body.adoption_prompt).toContain("Phase 2");
    expect(body.adoption_prompt).toContain("If Phase 1 finds no adoption work");
  });

  it("rejects invalid actions", async () => {
    const res = await POST(post({ action: "launch" }));
    expect(res.status).toBe(400);
  });
});
