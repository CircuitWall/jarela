import { test, expect, type APIRequestContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillExecutionPolicy, SkillRevisionTrust } from "@/lib/skills/execution-policy";

test.describe.configure({ mode: "serial" });

const endpoint = "/api/v1/security/skill-execution";
const defaults: SkillExecutionPolicy = { mode: "ask_each_time", trusted_revisions: [] };
let workspace: string;

async function readPolicy(request: APIRequestContext) {
  const response = await request.get(endpoint);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const body: { policy: SkillExecutionPolicy; execution_available: boolean; ownership: { available: boolean; reason?: string; backend?: string } } = await response.json();
  expect(typeof body.execution_available).toBe("boolean");
  expect(body.execution_available).toBe(body.ownership.available);
  if (body.ownership.available) expect(["windows-job", "linux-cgroup"]).toContain(body.ownership.backend);
  else expect(body.ownership.reason).toBeTruthy();
  return body.policy;
}

async function savePolicy(request: APIRequestContext, policy: SkillExecutionPolicy) {
  const response = await request.put(endpoint, { data: policy });
  expect(response.status()).toBe(200);
  const body: { policy: SkillExecutionPolicy; execution_available: boolean } = await response.json();
  expect(typeof body.execution_available).toBe("boolean");
  expect(await readPolicy(request)).toEqual(body.policy);
  return body.policy;
}

function scope(): SkillRevisionTrust {
  return {
    revision: "a".repeat(64), agent_id: "synthetic-policy-acceptance", workspace,
    max_timeout_ms: 1000, max_output_bytes: 64,
  };
}

test.beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "jarela-e2e-policy-workspace-"));
});

test.beforeEach(async ({ request }) => {
  await savePolicy(request, defaults);
});

test.afterEach(async ({ request }) => {
  await savePolicy(request, defaults);
});

test.afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

test("policy modes persist independently of host execution availability", async ({ request }) => {
  for (const mode of ["blocked", "approve_workflow", "trusted_revisions", "ask_each_time"] as const) {
    expect(await savePolicy(request, { mode, trusted_revisions: [] }))
      .toEqual({ mode, trusted_revisions: [] });
  }
});

test("malformed policies cannot replace an existing blocked policy", async ({ request }) => {
  const blocked: SkillExecutionPolicy = { mode: "blocked", trusted_revisions: [] };
  await savePolicy(request, blocked);
  const invalid = [
    {},
    { mode: "unknown", trusted_revisions: [] },
    { ...defaults, unexpected: true },
    { mode: "trusted_revisions", trusted_revisions: [{ ...scope(), workspace: "relative" }] },
    { mode: "trusted_revisions", trusted_revisions: [scope(), scope()] },
    { mode: "trusted_revisions", trusted_revisions: [{ ...scope(), revision: "invalid" }] },
    { mode: "trusted_revisions", trusted_revisions: [{ ...scope(), max_timeout_ms: 120001 }] },
    { mode: "trusted_revisions", trusted_revisions: [{ ...scope(), max_output_bytes: 262145 }] },
    { mode: "trusted_revisions", trusted_revisions: [{ ...scope(), max_timeout_ms: 999 }] },
    { mode: "trusted_revisions", trusted_revisions: [{ ...scope(), max_output_bytes: 0 }] },
  ];
  for (const policy of invalid) {
    const response = await request.put(endpoint, { data: policy });
    expect(response.status(), JSON.stringify(policy)).toBe(400);
    expect(await readPolicy(request)).toEqual(blocked);
  }
  const malformed = await request.put(endpoint, {
    data: "{", headers: { "content-type": "application/json" },
  });
  expect(malformed.status()).toBe(400);
  expect(await readPolicy(request)).toEqual(blocked);
});

test("trust receipts are server-issued, stable for unchanged scopes and renewed after revocation", async ({ request }) => {
  const fabricated = { id: "00000000-0000-4000-8000-000000000000", approved_at: "2000-01-01T00:00:00.000Z" };
  const saved = await savePolicy(request, {
    mode: "trusted_revisions", trusted_revisions: [{ ...scope(), approval: fabricated }],
  });
  const receipt = saved.trusted_revisions[0].approval;
  expect(receipt).toBeDefined();
  expect(receipt?.id).not.toBe(fabricated.id);
  expect(receipt?.approved_at).not.toBe(fabricated.approved_at);

  const unchanged = await savePolicy(request, {
    mode: "trusted_revisions", trusted_revisions: [{ ...scope(), approval: fabricated }],
  });
  expect(unchanged.trusted_revisions[0].approval).toEqual(receipt);

  const changed = await savePolicy(request, {
    mode: "trusted_revisions", trusted_revisions: [{ ...scope(), max_output_bytes: 65 }],
  });
  expect(changed.trusted_revisions[0].approval?.id).not.toBe(receipt?.id);
  await savePolicy(request, { mode: "trusted_revisions", trusted_revisions: [] });
  const readded = await savePolicy(request, {
    mode: "trusted_revisions", trusted_revisions: [{ ...scope(), max_output_bytes: 65 }],
  });
  expect(readded.trusted_revisions[0].approval?.id)
    .not.toBe(changed.trusted_revisions[0].approval?.id);
});

test("draft scopes outside trusted mode cannot retain a fabricated approval", async ({ request }) => {
  const saved = await savePolicy(request, {
    mode: "ask_each_time",
    trusted_revisions: [{
      ...scope(),
      approval: { id: "00000000-0000-4000-8000-000000000000", approved_at: "2000-01-01T00:00:00.000Z" },
    }],
  });
  expect(saved.trusted_revisions).toEqual([scope()]);
});

test("generic memory writes and deletion cannot bypass Security settings", async ({ request }) => {
  const blocked: SkillExecutionPolicy = { mode: "blocked", trusted_revisions: [] };
  await savePolicy(request, blocked);
  const item = "/api/v1/memory/app-settings/skill_execution_policy";
  const create = await request.post("/api/v1/memory", {
    data: { namespace: "app-settings", key: "skill_execution_policy", value: defaults },
  });
  expect(create.status()).toBe(403);
  expect(await readPolicy(request)).toEqual(blocked);
  const update = await request.put(item, { data: { value: defaults } });
  expect(update.status()).toBe(403);
  expect(await readPolicy(request)).toEqual(blocked);
  const remove = await request.delete(item);
  expect(remove.status()).toBe(403);
  expect(await readPolicy(request)).toEqual(blocked);
});
