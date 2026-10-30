import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillExecutionArtifact } from "./execution-artifact";
import { SkillRunConsent, skillInvocationDigest } from "./execution-consent";
import { SkillRunStaging } from "@/lib/stores/skill-run-staging";
import { runStagedSkill, SKILL_PRODUCTION_EXECUTION_AVAILABLE, type OwnedSkillProcess, type SkillProcessOwner } from "./execution-runner";

const root = vi.hoisted(() => ({ path: "" }));
vi.mock("@/lib/db/data-dir", () => ({ getDataDir: () => root.path }));
root.path = mkdtempSync(join(tmpdir(), "jarela-gated-runner-"));
afterAll(() => rmSync(root.path, { recursive: true, force: true }));
const bundle = join(root.path, "memory");
cpSync(join(process.cwd(), "lib", "skills", "builtins", "memory-organization"), bundle, { recursive: true });

async function* bytes(text: string) { yield Buffer.from(text); }
function processFixture(overrides: Partial<OwnedSkillProcess> = {}): OwnedSkillProcess {
  return {
    stdout: bytes('{"ok":true,"expired_keys":[],"duplicate_groups":[],"checks":["explicit_time","expiry","exact_kind_subject_content_expiry"],"limitation":"Synthetic fixture"}'),
    stderr: bytes(""), completion: Promise.resolve({ exitCode: 0, signal: null }),
    stopAndVerifyTree: async () => true, ...overrides,
  };
}
function setup(owner: SkillProcessOwner = { launch: () => processFixture() }) {
  const artifact = SkillExecutionArtifact.capture(bundle);
  const controller = new AbortController();
  const inputJson = JSON.stringify({ now: "2026-10-30T00:00:00Z", entries: [] });
  const manifest = artifact.getManifest();
  const binding = {
    agentId: "test-agent", runId: "test-run", workspace: root.path,
    artifactRevision: artifact.revision, inputDigest: skillInvocationDigest(inputJson),
    runtimeVersion: process.version, timeoutMs: manifest.timeoutMs, maxOutputBytes: manifest.maxOutputBytes,
  };
  const consent = new SkillRunConsent({
    agentId: binding.agentId, runId: binding.runId, workspace: binding.workspace,
  }, controller.signal);
  const proposal = consent.propose(binding);
  consent.decide(proposal.id, "approve");
  return {
    artifact, binding, consent, proposalId: proposal.id, inputJson, signal: controller.signal, controller, owner,
    policy: () => ({ executeAllowed: true, safeMode: false, blocked: false }),
  };
}

describe("gated staged skill orchestration", () => {
  it("exposes explicit execution without granting discovery any authority", () => {
    expect(SKILL_PRODUCTION_EXECUTION_AVAILABLE).toBe(true);
  });

  it("stages exact captured bytes, detects mutation and disposes only its owned run directory", () => {
    const artifact = SkillExecutionArtifact.capture(bundle);
    const staging = SkillRunStaging.create(artifact);
    expect(existsSync(staging.directory)).toBe(true);
    staging.verify();
    const file = join(staging.directory, "scripts", "run.mjs");
    chmodSync(file, 0o600);
    writeFileSync(file, "changed");
    expect(() => staging.verify()).toThrow(/changed/);
    staging.dispose();
    staging.dispose();
    expect(existsSync(staging.directory)).toBe(false);
    expect(existsSync(bundle)).toBe(true);
    expect(() => staging.verify()).toThrow(/disposed/);
  });

  it("runs the real reviewed memory planner 10/10 with exact Node, argv, input and empty environment", async () => {
    const owner: SkillProcessOwner = {
      launch(input) {
        expect(input.executable).toBe(process.execPath);
        expect(input.env).toEqual({});
        const child = spawn(input.executable, [...input.args], { cwd: input.cwd, env: input.env, shell: false });
        const completion = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
        });
        child.stdin.end(input.stdin);
        return {
          stdout: child.stdout, stderr: child.stderr, completion,
          // This reviewed fixture never creates descendants. This is not a
          // production tree-owner implementation for arbitrary skill code.
          async stopAndVerifyTree() { await completion; return child.exitCode !== null; },
        };
      },
    };
    for (let attempt = 0; attempt < 10; attempt++) {
      const input = setup(owner);
      const result = await runStagedSkill(input);
      input.consent.close();
      expect(result).toMatchObject({
        status: "succeeded", cleanupVerified: true, exitCode: 0, output: { ok: true, expired_keys: [], duplicate_groups: [] },
      });
    }
    expect(readdirSync(join(root.path, "skill-runs"))).toEqual([]);
  });

  it("does not spawn for stale bindings, denied policy, consumed consent or cancellation", async () => {
    for (const change of ["binding", "policy", "consumed", "cancelled"]) {
      const launch = vi.fn(() => processFixture());
      const input = setup({ launch });
      if (change === "binding") input.binding.inputDigest = "0".repeat(64);
      if (change === "policy") input.policy = () => ({ executeAllowed: true, safeMode: false, blocked: true });
      if (change === "consumed") input.consent.consume(input.proposalId, input.binding, input.policy());
      if (change === "cancelled") input.controller.abort();
      expect((await runStagedSkill(input)).status).not.toBe("succeeded");
      expect(launch).not.toHaveBeenCalled();
      input.consent.close();
    }
  });

  it("rechecks policy immediately before consuming consent and launching", async () => {
    const launch = vi.fn(() => processFixture());
    const input = setup({ launch });
    let checks = 0;
    input.policy = () => ({ executeAllowed: true, safeMode: false, blocked: ++checks === 2 });
    expect(await runStagedSkill(input)).toMatchObject({ status: "failed", error: "policy_denied", cleanupVerified: true });
    expect(launch).not.toHaveBeenCalled();
    input.consent.close();
  });

  it("fails closed if an unlisted file is added to a staged bundle", () => {
    const staging = SkillRunStaging.create(SkillExecutionArtifact.capture(bundle));
    writeFileSync(join(staging.directory, "unexpected.mjs"), "export default 1");
    expect(() => staging.verify()).toThrow(/Unexpected/);
    staging.dispose();
  });

  it("bounds timeout and refuses unverified or throwing process cleanup", async () => {
    vi.useFakeTimers();
    try {
      const stopped = vi.fn(async () => true);
      const input = setup({ launch: () => processFixture({ completion: new Promise(() => {}), stopAndVerifyTree: stopped }) });
      const running = runStagedSkill(input);
      await vi.advanceTimersByTimeAsync(5001);
      expect(await running).toMatchObject({ status: "timed_out", error: "timeout", cleanupVerified: true });
      expect(stopped).toHaveBeenCalledOnce();
      input.consent.close();
      for (const stopAndVerifyTree of [async () => { throw new Error("failure"); }, async () => new Promise<boolean>(() => {})]) {
        const bad = setup({ launch: () => processFixture({ stopAndVerifyTree }) });
        const pending = runStagedSkill(bad);
        await vi.advanceTimersByTimeAsync(1001);
        expect(await pending).toMatchObject({ status: "failed", error: "cleanup_unverified", cleanupVerified: false });
        bad.consent.close();
      }
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { stdout: bytes("{"), error: "invalid_result" },
    { stdout: bytes(" ".repeat(65537)), error: "output_limit" },
    { stderr: bytes(" ".repeat(16385)), error: "output_limit" },
    { completion: Promise.resolve({ exitCode: 1, signal: null }), error: "nonzero_exit" },
    { completion: Promise.resolve({ exitCode: null, signal: "SIGTERM" }), error: "nonzero_exit" },
  ])("rejects failed transport/exit and always invokes the owner cleanup: $error", async ({ error, ...overrides }) => {
    const stopAndVerifyTree = vi.fn(async () => true);
    const input = setup({ launch: () => processFixture({ ...overrides, stopAndVerifyTree }) });
    const result = await runStagedSkill(input);
    expect(result).toMatchObject({ status: "failed", error, cleanupVerified: true });
    expect(result).not.toHaveProperty("output");
    expect(stopAndVerifyTree).toHaveBeenCalledOnce();
    input.consent.close();
  });

  it("retains staging and reports cleanup failure rather than exposing success", async () => {
    const before = new Set(readdirSync(join(root.path, "skill-runs")));
    const input = setup({ launch: () => processFixture({ stopAndVerifyTree: async () => false }) });
    const result = await runStagedSkill(input);
    expect(result).toMatchObject({ status: "failed", error: "cleanup_unverified", cleanupVerified: false });
    expect(result).not.toHaveProperty("output");
    const retained = readdirSync(join(root.path, "skill-runs")).filter((file) => !before.has(file));
    expect(retained).toHaveLength(1);
    // Test fixture has no running processes; targeted test-only cleanup.
    rmSync(join(root.path, "skill-runs", retained[0]), { recursive: true });
    input.consent.close();
  });

  it("does not claim cleanup when launch throws before returning process ownership", async () => {
    const before = new Set(readdirSync(join(root.path, "skill-runs")));
    const input = setup({ launch: () => { throw new Error("Launch outcome unknown"); } });
    expect(await runStagedSkill(input)).toMatchObject({
      status: "failed", error: "cleanup_unverified", cleanupVerified: false,
    });
    const retained = readdirSync(join(root.path, "skill-runs")).filter((file) => !before.has(file));
    expect(retained).toHaveLength(1);
    // Synthetic adapter never launched anything; remove its test-only directory.
    rmSync(join(root.path, "skill-runs", retained[0]), { recursive: true });
    input.consent.close();
  });

  it("cancels a hanging operation, cleans through the owner and never parses its partial success", async () => {
    const stopAndVerifyTree = vi.fn(async () => true);
    const input = setup({ launch: () => processFixture({
      completion: new Promise(() => {}), stopAndVerifyTree,
    }) });
    const running = runStagedSkill(input);
    input.controller.abort();
    expect(await running).toMatchObject({ status: "cancelled", cleanupVerified: true });
    expect(stopAndVerifyTree).toHaveBeenCalledOnce();
  });
});
