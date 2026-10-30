import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

const locks = vi.hoisted(() => ({ master: false, screen: false }));
vi.mock("@/lib/crypto/master-key", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/crypto/master-key")>(),
  isMasterKeyLocked: () => locks.master,
}));
vi.mock("@/lib/security/screen-lock", () => ({ isScreenLocked: () => locks.screen }));
vi.mock("@/lib/skills/process-owner", () => ({
  getSkillProcessOwnerAvailability: () => ({ available: false, reason: "Synthetic unsupported host" }),
}));

const route = await import("@/app/api/v1/security/skill-execution/route");
const settings = await import("@/lib/stores/app-settings");
const { closeDb, getDb } = await import("@/lib/db");
const { resolveSkillExecutionConsentRequirement } = await import("@/lib/skills/execution-policy-server");
const { defaultSkillExecutionPolicy } = await import("@/lib/skills/execution-policy");
const target = {
  revision: "a".repeat(64), agent_id: "test-agent", workspace: resolve("test-workspace"),
  timeout_ms: 60_000, max_output_bytes: 65_536,
};
const trust = {
  revision: target.revision, agent_id: target.agent_id, workspace: target.workspace,
  max_timeout_ms: 60_000, max_output_bytes: 65_536,
};
function req(body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:4312/api/v1/security/skill-execution", {
    method: body === undefined ? "GET" : "PUT",
    headers: { host: "localhost:4312", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  locks.master = false;
  locks.screen = false;
  vi.stubEnv("JARELA_TOOL_SAFETY", "mostly_safe");
  getDb().prepare("DELETE FROM memory_store WHERE namespace=? AND key=?").run("app-settings", "skill_execution_policy");
});
afterAll(() => { vi.unstubAllEnvs(); closeDb(); });

describe("skill execution Security settings API and store", () => {
  it("returns non-cached defaults and explicit execution unavailability", async () => {
    const res = route.GET(req());
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      policy: defaultSkillExecutionPolicy(), safety_mode: "mostly_safe", execution_available: false,
      ownership: { available: false, reason: "Synthetic unsupported host" },
    });
  });

  it("persists exact trust across database reopen, then revokes it immediately", async () => {
    const policy = { mode: "trusted_revisions", trusted_revisions: [trust] };
    const savedResponse = await route.PUT(req(policy));
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json();
    expect(saved.policy.trusted_revisions[0]).toMatchObject({
      ...trust, approval: { id: expect.any(String), approved_at: expect.any(String) },
    });
    closeDb();
    expect(settings.getSkillExecutionPolicy()).toEqual(saved.policy);
    expect(resolveSkillExecutionConsentRequirement(target, true)).toEqual({ kind: "trusted_revision" });
    await route.PUT(req({ ...policy, trusted_revisions: [] }));
    expect(resolveSkillExecutionConsentRequirement(target, true)).toEqual({ kind: "require_invocation_consent" });
  });

  it.each([
    ["blocked", "blocked"], ["ask_each_time", "require_invocation_consent"],
    ["approve_workflow", "require_workflow_consent"], ["trusted_revisions", "require_invocation_consent"],
  ] as const)("persists %s and enforces its consent requirement", async (mode, kind) => {
    const policy = { mode, trusted_revisions: [] };
    expect((await route.PUT(req(policy))).status).toBe(200);
    expect((await route.GET(req()).json()).policy).toEqual(policy);
    expect(resolveSkillExecutionConsentRequirement(target, true).kind).toBe(kind);
  });

  it("reads current safety policy and execute capability for each evaluation", () => {
    settings.setSkillExecutionPolicy({ mode: "trusted_revisions", trusted_revisions: [trust] });
    expect(resolveSkillExecutionConsentRequirement(target, true).kind).toBe("trusted_revision");
    vi.stubEnv("JARELA_TOOL_SAFETY", "safe");
    expect(resolveSkillExecutionConsentRequirement(target, true).kind).toBe("blocked");
    vi.stubEnv("JARELA_TOOL_SAFETY", "bypass");
    expect(resolveSkillExecutionConsentRequirement(target, false).kind).toBe("blocked");
    settings.setSkillExecutionPolicy({ mode: "blocked", trusted_revisions: [trust] });
    expect(resolveSkillExecutionConsentRequirement(target, true).kind).toBe("blocked");
  });

  it.each(["master", "screen"] as const)("refuses reads and writes while %s locked", async (key) => {
    locks[key] = true;
    expect(route.GET(req()).status).toBe(423);
    expect((await route.PUT(req(defaultSkillExecutionPolicy()))).status).toBe(423);
  });

  it.each([{ host: "remote.example" }, { "tailscale-user-login": "user@example.test" }])(
    "refuses nonlocal settings management %j", async (headers) => {
      expect(route.GET(req(undefined, headers)).status).toBe(403);
      expect((await route.PUT(req(defaultSkillExecutionPolicy(), headers))).status).toBe(403);
    },
  );

  it.each([
    {}, { mode: "allow_all", trusted_revisions: [] }, { mode: "ask_each_time", trusted_revisions: [], extra: true },
    { mode: "trusted_revisions", trusted_revisions: [{ ...trust, workspace: "relative" }] },
    { mode: "trusted_revisions", trusted_revisions: [{ ...trust, workspace: resolve("test-workspace") + "\0" }] },
  ])("rejects invalid writes without changing policy %j", async (value) => {
    expect((await route.PUT(req(value))).status).toBe(400);
    expect(settings.getSkillExecutionPolicy()).toEqual(defaultSkillExecutionPolicy());
  });

  it("rejects bad JSON and stored corruption explicitly", async () => {
    const bad = new NextRequest("http://localhost:4312/api/v1/security/skill-execution", {
      method: "PUT", headers: { host: "localhost:4312" }, body: "{",
    });
    expect((await route.PUT(bad)).status).toBe(400);
    settings.setSkillExecutionPolicy(defaultSkillExecutionPolicy());
    getDb().prepare("UPDATE memory_store SET value=? WHERE namespace=? AND key=?")
      .run("{", "app-settings", "skill_execution_policy");
    expect(() => settings.getSkillExecutionPolicy()).toThrow();
    expect(() => resolveSkillExecutionConsentRequirement(target, true)).toThrow();
  });

  it("refuses relative workspace targets even if a caller fabricates matching strings", () => {
    expect(resolveSkillExecutionConsentRequirement({ ...target, workspace: "relative" }, true).kind).toBe("blocked");
    expect(() => settings.setSkillExecutionPolicy({ mode: "trusted_revisions", trusted_revisions: [{ ...trust, workspace: "relative" }] }))
      .toThrow(/absolute normalized/);
  });

  it("prevents generic memory APIs and store operations from changing or resetting policy", async () => {
    settings.setSkillExecutionPolicy({ mode: "blocked", trusted_revisions: [] });
    const memory = await import("@/lib/stores/memory");
    const collection = await import("@/app/api/v1/memory/route");
    const item = await import("@/app/api/v1/memory/[namespace]/[key]/route");
    const params = { params: Promise.resolve({ namespace: "app-settings", key: "skill_execution_policy" }) };
    expect(() => memory.putMemory("app-settings", "skill_execution_policy", defaultSkillExecutionPolicy())).toThrow(/Security settings/);
    expect(() => memory.deleteMemory("app-settings", "skill_execution_policy")).toThrow(/Security settings/);
    expect((await collection.POST(req({ namespace: "app-settings", key: "skill_execution_policy", value: defaultSkillExecutionPolicy() }))).status).toBe(403);
    expect((await item.PUT(req({ value: defaultSkillExecutionPolicy() }), params)).status).toBe(403);
    expect((await item.DELETE(req(), params)).status).toBe(403);
    const tools = await import("@/lib/tools/general/memory");
    await expect(tools.memoryWriteTool.invoke({
      namespace: "app-settings", key: "skill_execution_policy", value: JSON.stringify(defaultSkillExecutionPolicy()),
    })).rejects.toThrow(/Security settings/);
    await expect(tools.memoryDeleteTool.invoke({
      namespace: "app-settings", key: "skill_execution_policy",
    })).rejects.toThrow(/Security settings/);
    await expect(tools.memoryUpsertTool.invoke({
      namespace: "app-settings", key: "skill_execution_policy",
      record: {
        kind: "preference", subject: "Policy", content: "Try to change security policy",
        tags: [], confidence: "explicit", source: "conversation", observed_at: "2026-10-28T00:00:00Z", expires_at: null,
      },
    })).rejects.toThrow(/Security settings/);
    expect(settings.getSkillExecutionPolicy().mode).toBe("blocked");
  });

  it("preserves a checksum approval record across repeated saves and mode switches", () => {
    const first = settings.setSkillExecutionPolicy({ mode: "trusted_revisions", trusted_revisions: [trust] });
    const receipt = first.trusted_revisions[0].approval;
    expect(receipt?.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(Number.isFinite(Date.parse(receipt!.approved_at))).toBe(true);
    const repeated = settings.setSkillExecutionPolicy(first);
    expect(repeated.trusted_revisions[0].approval).toEqual(receipt);
    const blocked = settings.setSkillExecutionPolicy({ ...first, mode: "blocked" });
    expect(blocked.trusted_revisions[0].approval).toEqual(receipt);
    expect(settings.setSkillExecutionPolicy({ ...blocked, mode: "trusted_revisions" }).trusted_revisions[0].approval).toEqual(receipt);
  });

  it("does not accept forged receipt metadata or recover a revoked approval", () => {
    const forged = { id: "00000000-0000-4000-8000-000000000001", approved_at: "2000-01-01T00:00:00.000Z" };
    const first = settings.setSkillExecutionPolicy({
      mode: "trusted_revisions", trusted_revisions: [{ ...trust, approval: forged }],
    });
    expect(first.trusted_revisions[0].approval).not.toEqual(forged);
    settings.setSkillExecutionPolicy({ mode: "trusted_revisions", trusted_revisions: [] });
    const renewed = settings.setSkillExecutionPolicy(first);
    expect(renewed.trusted_revisions[0].approval?.id).not.toBe(first.trusted_revisions[0].approval?.id);
  });

  it.each([
    { revision: "b".repeat(64) }, { agent_id: "another-agent" }, { workspace: resolve("another-workspace") },
    { max_timeout_ms: 60_001 }, { max_output_bytes: 65_537 },
  ])("creates a fresh approval for changed identity or grant ceilings: %j", (change) => {
    const first = settings.setSkillExecutionPolicy({ mode: "trusted_revisions", trusted_revisions: [trust] });
    const next = settings.setSkillExecutionPolicy({
      mode: "trusted_revisions", trusted_revisions: [{ ...first.trusted_revisions[0], ...change }],
    });
    expect(next.trusted_revisions[0].approval?.id).not.toBe(first.trusted_revisions[0].approval?.id);
  });

  it("stores inactive draft scopes without an approval and issues it only when explicitly enabling trust", () => {
    const draft = settings.setSkillExecutionPolicy({ mode: "ask_each_time", trusted_revisions: [trust] });
    expect(draft.trusted_revisions[0].approval).toBeUndefined();
    const activated = settings.setSkillExecutionPolicy({ ...draft, mode: "trusted_revisions" });
    expect(activated.trusted_revisions[0].approval).toBeDefined();
    expect(resolveSkillExecutionConsentRequirement(target, true).kind).toBe("trusted_revision");
  });
});
