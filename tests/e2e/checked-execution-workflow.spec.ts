import { test, expect, type APIRequestContext } from "@playwright/test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun } from "@/api/types";

test.describe.configure({ mode: "serial" });
let agentId: string;
let workspace: string;
const invocation = '{"now":"2026-10-30T00:00:00Z","entries":[]}';
const defaults = { mode: "ask_each_time", trusted_revisions: [] };
async function mutate(request: APIRequestContext, run: WorkflowRun, action: string, extra = {}) {
  const response = await request.post(`/api/v1/workflows/${run.id}`, {
    data: { action, agentId, version: run.version, ...extra },
  });
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as WorkflowRun;
}
async function supported(request: APIRequestContext) {
  const response = await request.get("/api/v1/security/skill-execution");
  expect(response.ok()).toBe(true);
  const body = await response.json();
  test.skip(!body.execution_available, body.ownership?.reason ?? "No process-owner backend");
}
test.beforeAll(async ({ request }) => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "jarela-checked-acceptance-")));
  const response = await request.post("/api/v1/agents", { data: {
    name: "Synthetic checked execution", tools: ["run_skill", "run_workflow", "advance_workflow", "inspect_workflow", "cancel_workflow", "reconcile_workflow", "file_read", "file_write"],
  } });
  expect(response.status()).toBe(201);
  agentId = (await response.json()).id;
});
test.beforeEach(async ({ request }) => {
  expect((await request.put("/api/v1/security/skill-execution", { data: defaults })).status()).toBe(200);
});
test.afterAll(async ({ request }) => {
  if (agentId) await request.delete(`/api/v1/agents/${agentId}`);
  await request.put("/api/v1/security/skill-execution", { data: defaults });
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});
test("explicit approval executes the reviewed built-in through the real platform owner once", async ({ request }) => {
  await supported(request);
  const response = await request.post("/api/v1/skill-executions", { data: {
    agent_id: agentId, skill_id: "memory-organization", input_json: invocation, workspace,
  } });
  expect(response.status(), await response.text()).toBe(200);
  const pending = await response.json();
  expect(pending.status).toBe("pending");
  const review = await request.get(`/api/v1/skill-executions/${pending.request_id}`);
  const detail = await review.json();
  expect(detail.input_json).toBe(invocation);
  expect(detail.files.map((file: { path: string }) => file.path)).toContain("scripts/run.mjs");
  const approval = await request.post(`/api/v1/pending-actions/${pending.proposal_id}/approve`);
  expect(approval.status(), await approval.text()).toBe(200);
  expect((await approval.json()).status).toBe("approved");
  const finished = await (await request.get(`/api/v1/skill-executions/${pending.request_id}`)).json();
  expect(finished.result).toMatchObject({ status: "succeeded", cleanupVerified: true, output: { ok: true, expired_keys: [], duplicate_groups: [] } });
  expect((await request.post(`/api/v1/pending-actions/${pending.proposal_id}/approve`)).status()).toBe(409);
});
test("denied or policy-revoked requests never launch and cannot be reused", async ({ request }) => {
  await supported(request);
  for (const decision of ["deny", "revoke"]) {
    const pending = await (await request.post("/api/v1/skill-executions", { data: {
      agent_id: agentId, skill_id: "memory-organization", input_json: invocation, workspace,
    } })).json();
    if (decision === "deny") {
      expect((await request.post(`/api/v1/pending-actions/${pending.proposal_id}/deny`)).status()).toBe(200);
      expect((await request.get(`/api/v1/skill-executions/${pending.request_id}`)).status()).toBe(404);
    } else {
      expect((await request.put("/api/v1/security/skill-execution", { data: { mode: "blocked", trusted_revisions: [] } })).status()).toBe(200);
      const approval = await request.post(`/api/v1/pending-actions/${pending.proposal_id}/approve`);
      expect((await approval.json()).status).toBe("failed");
      const detail = await (await request.get(`/api/v1/skill-executions/${pending.request_id}`)).json();
      expect(detail).toMatchObject({ status: "finished", result: null, error: expect.any(String) });
    }
    expect((await request.post(`/api/v1/pending-actions/${pending.proposal_id}/approve`)).status()).toBe(409);
  }
});
test("packaged workflow requires separate plan approval and a typed version-bound human answer", async ({ request }) => {
  await supported(request);
  const template = await (await request.get("/api/v1/workflow-templates/memory-organization")).json();
  const created = await request.post("/api/v1/workflows", { data: {
    agentId, workspace, definitionText: template.definitionText, invocationJson: invocation,
  } });
  expect(created.status(), await created.text()).toBe(200);
  let run: WorkflowRun = await created.json();
  run = await mutate(request, run, "advance");
  expect(run.phase).toBe("ready");
  expect(run.executionApproval?.kind).toBe("approval_required");
  const plan = run.executionApproval!;
  const detail = await (await request.get(`/api/v1/workflow-approvals/${plan.requestId}`)).json();
  expect(detail.definition_json).toBe(template.definitionText);
  expect(detail.input_json).toBe(invocation);
  expect((await request.post(`/api/v1/pending-actions/${plan.proposalId}/approve`)).status()).toBe(200);
  run = await mutate(request, run, "advance");
  expect(run.phase).toBe("waiting");
  expect(run.steps[0]).toMatchObject({ status: "done", origin: "script", attempts: 1 });
  expect(run.question).toMatchObject({ stepId: "review", executionApproval: false });
  const waiting = run;
  run = await mutate(request, waiting, "answer", { revision: waiting.revision, stepId: "review", answerJson: '{"decision":"keep"}' });
  expect(run.phase).toBe("completed");
  expect((await request.post(`/api/v1/workflows/${waiting.id}`, { data: {
    action: "answer", agentId, version: waiting.version, revision: waiting.revision, stepId: "review", answerJson: '{"decision":"review"}',
  } })).status()).toBe(409);
  const stranger = await request.get(`/api/v1/workflows/${run.id}?agentId=another-agent`);
  expect(stranger.status()).not.toBe(200);
});
test("typed choices work without scripts and reject invalid answers without consuming the version", async ({ request }) => {
  const definitionText = JSON.stringify({ schemaVersion: 1, id: "synthetic-choice", steps: [{
    id: "choice", kind: "choice", action: "ask_choice", effect: "read", input: { from: "literal", value: {} },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { decision: { type: "string", enum: ["keep"] } }, required: ["decision"], additionalProperties: false },
  }] });
  let run: WorkflowRun = await (await request.post("/api/v1/workflows", { data: { agentId, workspace, definitionText } })).json();
  run = await mutate(request, run, "advance");
  expect(run.phase).toBe("waiting");
  const invalid = await request.post(`/api/v1/workflows/${run.id}`, { data: {
    action: "answer", agentId, version: run.version, revision: run.revision, stepId: "choice", answerJson: '{"decision":"invented"}',
  } });
  expect(invalid.status()).toBe(400);
  const retained = await (await request.get(`/api/v1/workflows/${run.id}?agentId=${agentId}`)).json();
  expect(retained.version).toBe(run.version);
  expect((await mutate(request, run, "cancel")).phase).toBe("cancelled");
});
test("uncertain writes are not replayed and reconcile only through actual workspace-scoped read-back", async ({ request }) => {
  const content = "Synthetic checked write, observed after an incompatible immediate-result contract.";
  const definitionText = JSON.stringify({ schemaVersion: 1, id: "synthetic-readback", steps: [{
    id: "write", kind: "tool", action: "file_write", effect: "write", maxAttempts: 1, reconcileAction: "file_read",
    input: { from: "literal", value: { path: "observed.txt", content } },
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    outputSchema: { type: "object", properties: { ok: { type: "boolean", enum: [true] }, content: { type: "string", enum: [content] } }, required: ["ok", "content"], additionalProperties: true },
  }] });
  let run: WorkflowRun = await (await request.post("/api/v1/workflows", { data: { agentId, workspace, definitionText } })).json();
  run = await mutate(request, run, "advance");
  expect(run.phase).toBe("uncertain");
  expect(run.steps[0].attempts).toBe(1);
  expect(readFileSync(join(workspace, "observed.txt"), "utf8")).toBe(content);
  run = await mutate(request, run, "reconcile");
  expect(run.phase).toBe("completed");
  expect(run.steps[0]).toMatchObject({ attempts: 1, status: "done", output: { content, ok: true } });
  expect(readFileSync(join(workspace, "observed.txt"), "utf8")).toBe(content);
});
