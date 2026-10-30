import { afterEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillExecutionArtifact } from "@/lib/skills/execution-artifact";
import { parseWorkflowDefinition } from "./definition";
import { approveWorkflowAuthorization, consumeWorkflowScriptAuthorization, inspectWorkflowAuthorization,
  requestWorkflowAuthorization, revokeWorkflowAuthorizations } from "./authorization";

const state = vi.hoisted(() => ({ directory: "", proposal: vi.fn(() => ({ id: "synthetic-proposal" })) }));
vi.mock("@/lib/skills", () => ({ resolveSkill: () => ({ directory: state.directory }) }));
vi.mock("@/lib/stores/pending-actions", () => ({ createPendingAction: state.proposal }));
const roots: string[] = [];
const runIds: string[] = [];
afterEach(() => {
  for (const id of runIds.splice(0)) revokeWorkflowAuthorizations(id);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers(); vi.clearAllMocks();
});
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jarela-workflow-consent-")));
  roots.push(root);
  state.directory = join(root, "memory");
  cpSync(join(process.cwd(), "lib", "skills", "builtins", "memory-organization"), state.directory, { recursive: true });
  const definitionText = readFileSync(join(state.directory, "workflow.json"), "utf8");
  const runId = `synthetic-${roots.length}`;
  runIds.push(runId);
  const input = { runId, agentId: "synthetic-agent", workspace: root, definitionText,
    invocationJson: '{"now":"2026-10-30T00:00:00Z","entries":[]}' };
  const claim = { ...input, stepId: "plan", skillId: "memory-organization",
    revision: parseWorkflowDefinition(definitionText).revision,
    artifactRevision: SkillExecutionArtifact.capture(state.directory).revision };
  return { input, claim };
}
describe("bounded workflow execution consent", () => {
  it("binds exact plan/invocation/artifacts and consumes each script step once", () => {
    const { input, claim } = setup();
    const pending = requestWorkflowAuthorization(input);
    expect(pending.status).toBe("pending");
    expect(requestWorkflowAuthorization(input)).toEqual(pending);
    expect(() => consumeWorkflowScriptAuthorization(claim)).toThrow(/Missing/);
    const detail = inspectWorkflowAuthorization(pending.authorization_id!);
    expect(detail).toMatchObject({ input_json: input.invocationJson, definition_json: input.definitionText });
    expect(detail.files.length).toBeGreaterThan(0);
    approveWorkflowAuthorization(pending.authorization_id!);
    expect(() => approveWorkflowAuthorization(pending.authorization_id!)).toThrow(/already/);
    expect(() => consumeWorkflowScriptAuthorization({ ...claim, invocationJson: '{"entries":[]}' })).toThrow(/Missing/);
    consumeWorkflowScriptAuthorization(claim);
    expect(() => consumeWorkflowScriptAuthorization(claim)).toThrow(/consumed/);
  });
  it("rejects source mutation and expired or revoked plan grants", () => {
    vi.useFakeTimers();
    const { input, claim } = setup();
    let pending = requestWorkflowAuthorization(input);
    const script = join(state.directory, "scripts", "run.mjs");
    writeFileSync(script, readFileSync(script, "utf8") + "\n// Synthetic change\n");
    expect(() => approveWorkflowAuthorization(pending.authorization_id!)).toThrow(/changed/);
    pending = requestWorkflowAuthorization(input);
    approveWorkflowAuthorization(pending.authorization_id!);
    vi.advanceTimersByTime(300001);
    expect(() => consumeWorkflowScriptAuthorization(claim)).toThrow(/Missing/);
    expect(() => inspectWorkflowAuthorization(pending.authorization_id!)).toThrow(/expired/);
  });
});
