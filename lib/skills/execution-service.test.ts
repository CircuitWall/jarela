import { afterEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillExecutionService } from "./execution-service";
import type { SkillExecutionPolicyDecision } from "./execution-policy";

const root = vi.hoisted(() => ({ path: "" }));
vi.mock("@/lib/db/data-dir", () => ({ getDataDir: () => root.path }));
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function* bytes(text: string) { yield Buffer.from(text); }
function setup() {
  root.path = realpathSync(mkdtempSync(join(tmpdir(), "jarela-execution-service-")));
  directories.push(root.path);
  const bundle = join(root.path, "bundle");
  cpSync(join(process.cwd(), "lib", "skills", "builtins", "memory-organization"), bundle, { recursive: true });
  let allowed = true;
  let policy: SkillExecutionPolicyDecision = { kind: "require_invocation_consent" };
  const launch = vi.fn(() => ({
    stdout: bytes('{"ok":true,"expired_keys":[],"duplicate_groups":[],"checks":["explicit_time","expiry","exact_kind_subject_content_expiry"],"limitation":"Synthetic fixture"}'),
    stderr: bytes(""), completion: Promise.resolve({ exitCode: 0, signal: null }),
    stopAndVerifyTree: async () => true,
  }));
  const expire = vi.fn();
  const proposal = vi.fn(() => "synthetic-proposal");
  const service = new SkillExecutionService({
    directory: () => bundle, authorize: () => allowed,
    policy: (_target, enabled) => enabled ? policy : { kind: "blocked", reason: "Execute disabled" },
    owner: () => ({ launch }), proposal, expire,
  });
  const request = { agentId: "synthetic-agent", skillId: "memory-organization", workspace: root.path,
    inputJson: '{"now":"2026-10-30T00:00:00Z","entries":[]}' };
  return { service, request, launch, expire, proposal, bundle,
    setAllowed(value: boolean) { allowed = value; }, setPolicy(value: SkillExecutionPolicyDecision) { policy = value; } };
}

describe("application skill execution lifecycle", () => {
  it("queues exact-artifact review without persisting invocation or code and consumes it once", async () => {
    const { service, request, launch, proposal } = setup();
    const pending = await service.request(request);
    expect(pending.status).toBe("pending");
    expect(launch).not.toHaveBeenCalled();
    expect(proposal.mock.calls[0]).not.toContain(request.inputJson);
    expect(service.inspect(pending.request_id)).toMatchObject({ input_json: request.inputJson, status: "pending" });
    expect(await service.approve({ request_id: pending.request_id })).toMatchObject({ status: "succeeded", cleanupVerified: true });
    await expect(service.approve({ request_id: pending.request_id })).rejects.toThrow(/claimed/);
    expect(launch).toHaveBeenCalledOnce();
    expect(service.inspect(pending.request_id).result?.status).toBe("succeeded");
  });

  it("rejects changed code and revoked capability before launch", async () => {
    for (const change of ["source", "permission", "policy"]) {
      const fixture = setup();
      const pending = await fixture.service.request(fixture.request);
      if (change === "source") {
        const path = join(fixture.bundle, "scripts", "run.mjs");
        writeFileSync(path, readFileSync(path, "utf8") + "\n// Synthetic mutation\n");
      } else if (change === "permission") fixture.setAllowed(false);
      else fixture.setPolicy({ kind: "blocked", reason: "Revoked policy" });
      await expect(fixture.service.approve({ request_id: pending.request_id })).rejects.toThrow();
      expect(fixture.service.inspect(pending.request_id)).toMatchObject({ status: "finished", error: expect.any(String) });
      await expect(fixture.service.approve({ request_id: pending.request_id })).rejects.toThrow(/claimed/);
      expect(fixture.launch).not.toHaveBeenCalled();
      await fixture.service.close();
    }
  });

  it("runs exact trusted revisions without creating a repeated human proposal", async () => {
    const fixture = setup();
    fixture.setPolicy({ kind: "trusted_revision" });
    expect(await fixture.service.request(fixture.request)).toMatchObject({ status: "finished", result: { status: "succeeded" } });
    expect(fixture.proposal).not.toHaveBeenCalled();
    expect(fixture.launch).toHaveBeenCalledOnce();
  });

  it("does not recover consent from another app instance or accept another agent's request", async () => {
    const fixture = setup();
    const pending = await fixture.service.request(fixture.request);
    expect(() => fixture.service.inspect(pending.request_id, "different-agent")).toThrow(/another agent/);
    const other = setup();
    await expect(other.service.approve({ request_id: pending.request_id })).rejects.toThrow(/previous app instance/);
    fixture.service.cancel(pending.request_id);
  });

  it("expires pending proposals and invalidates their in-memory snapshots", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const pending = await fixture.service.request(fixture.request);
    await vi.advanceTimersByTimeAsync(300001);
    expect(fixture.expire).toHaveBeenCalledWith("synthetic-proposal");
    expect(() => fixture.service.inspect(pending.request_id)).toThrow(/expired/);
    expect(fixture.launch).not.toHaveBeenCalled();
  });

  it("denies missing workflow-wide authorization rather than promoting a question to consent", async () => {
    const fixture = setup();
    fixture.setPolicy({ kind: "require_workflow_consent" });
    await expect(fixture.service.request(fixture.request)).rejects.toThrow(/Workflow-wide authorization/);
    expect(fixture.launch).not.toHaveBeenCalled();
  });

  it("invalidates pending consent immediately on caller abort and refuses new work after shutdown", async () => {
    const fixture = setup();
    const controller = new AbortController();
    const pending = await fixture.service.request({ ...fixture.request, signal: controller.signal });
    controller.abort();
    expect(fixture.expire).toHaveBeenCalledWith("synthetic-proposal");
    expect(() => fixture.service.inspect(pending.request_id)).toThrow(/expired/);
    expect(fixture.launch).not.toHaveBeenCalled();
    await fixture.service.close();
    await expect(fixture.service.request(fixture.request)).rejects.toThrow(/shutting down/);
  });
});
