import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRunStore } from "@/lib/stores/workflow-runs";
import { planMemoryCleanup } from "@/lib/skills/builtins/memory-organization/scripts/plan-cleanup.mjs";
import { SkillExecutionArtifact } from "@/lib/skills/execution-artifact";
import { runStagedSkill, type SkillProcessOwner } from "@/lib/skills/execution-runner";
import { SkillRunConsent, skillInvocationDigest } from "@/lib/skills/execution-consent";
import { parseWorkflowDefinition } from "./definition";
import { BoundedWorkflowRuntime, WORKFLOW_PRODUCTION_ACTIVATION_AVAILABLE, type WorkflowHost } from "./runtime";

const stagingRoot = vi.hoisted(() => ({ path: "" }));
vi.mock("@/lib/db/data-dir", () => ({ getDataDir: () => stagingRoot.path }));
const objectSchema = { type: "object", properties: {}, additionalProperties: true };
const literal = { from: "literal", value: {} };
const baseStep = {
  id: "first", kind: "tool", action: "read", effect: "read", input: literal,
  inputSchema: objectSchema, outputSchema: objectSchema, maxAttempts: 1, timeoutMs: 1000,
};
const text = (steps: unknown[], inputSchema: unknown = { type: "object", properties: {}, additionalProperties: false }) =>
  JSON.stringify({ schemaVersion: 1, id: "synthetic", inputSchema, steps });
const stepOutput = (output: unknown) => ({
  kind: "output" as const, json: JSON.stringify(output), evidence: "Synthetic observed output", origin: "tool" as const,
});
const databases: DatabaseSync[] = [];
const paths: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.useRealTimers();
});
function store(path = ":memory:") {
  const db = new DatabaseSync(path);
  databases.push(db);
  return new WorkflowRunStore(db);
}
const signal = () => new AbortController().signal;

describe("bounded workflow definition", () => {
  it("exposes explicit app workflow entry points and validates ordered acyclic bindings", () => {
    expect(WORKFLOW_PRODUCTION_ACTIVATION_AVAILABLE).toBe(true);
    expect(parseWorkflowDefinition(text([baseStep])).steps).toHaveLength(1);
    for (const steps of [
      [],
      [baseStep, baseStep],
      [{ ...baseStep, input: { from: "step", step: "later" } }],
      [{ ...baseStep, input: { from: "step", step: "first" } }],
      [{ ...baseStep, maxAttempts: 4 }],
      [{ ...baseStep, effect: "write", maxAttempts: 2 }],
      [{ ...baseStep, kind: "script", maxAttempts: 2 }],
      [{ ...baseStep, kind: "validate", effect: "write" }],
      [{ ...baseStep, reconcileAction: "read_back" }],
      [{ ...baseStep, kind: "script", effect: "read", reconcileAction: "read_back" }],
      [{ ...baseStep, effect: "write", reconcileAction: "Invalid Action" }],
      [{ ...baseStep, outputSchema: { type: "string", pattern: ".*" } }],
      Array.from({ length: 33 }, (_, index) => ({ ...baseStep, id: `step${index}` })),
    ]) expect(() => parseWorkflowDefinition(text(steps))).toThrow();
    expect(parseWorkflowDefinition(text([{ ...baseStep, effect: "write", reconcileAction: "read_back" }])).steps[0])
      .toMatchObject({ effect: "write", reconcileAction: "read_back" });
    expect(() => parseWorkflowDefinition(" ".repeat(65537))).toThrow(/64 KiB/);
  });
});

describe("gated durable workflow coordinator", () => {
  it("runs the packaged read-only cleanup workflow with separately validated invocation data", async () => {
    const root = join(process.cwd(), "lib", "skills", "builtins", "memory-organization");
    const definitionText = readFileSync(join(root, "workflow.json"), "utf8");
    const definition = parseWorkflowDefinition(definitionText);
    const manifest = SkillExecutionArtifact.capture(root).getManifest();
    expect(definition.inputContract.inputSchema).toEqual(manifest.inputSchema);
    expect(definition.steps[0].contract.inputSchema).toEqual(manifest.inputSchema);
    const execute = vi.fn<WorkflowHost["execute"]>(async (_step, input) => ({ ...stepOutput(planMemoryCleanup(input)), origin: "script" as const }));
    const runtime = new BoundedWorkflowRuntime(store(), { execute });
    expect(() => runtime.create(definitionText, '{"now":"today","entries":[{}]}')).toThrow();
    const created = runtime.create(definitionText, '{"now":"2026-10-30T00:00:00Z","entries":[]}');
    const waiting = await runtime.advance(created.id, signal());
    expect(runtime.inspect(created.id).choice).toMatchObject({ ok: true, expired_keys: [], duplicate_groups: [] });
    expect(() => runtime.answer(created.id, waiting.version, created.revision, "review", '{"decision":"delete"}')).toThrow();
    expect(JSON.parse(runtime.answer(created.id, waiting.version, created.revision, "review", '{"decision":"keep"}').state).phase)
      .toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("runs a mixed memory cleanup workflow 10/10 with deterministic checks, retry and choice", async () => {
    stagingRoot.path = mkdtempSync(join(tmpdir(), "jarela-mixed-workflow-"));
    paths.push(stagingRoot.path);
    const artifact = SkillExecutionArtifact.capture(join(process.cwd(), "lib", "skills", "builtins", "memory-organization"));
    const manifest = artifact.getManifest();
    const processOwner: SkillProcessOwner = {
      launch(input) {
        const child = spawn(input.executable, [...input.args], { cwd: input.cwd, env: input.env, shell: false });
        const completion = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
        });
        child.stdin.end(input.stdin);
        return {
          stdout: child.stdout, stderr: child.stderr, completion,
          // Reviewed fixture has no descendants; not an arbitrary-code backend.
          async stopAndVerifyTree() { await completion; return child.exitCode !== null; },
        };
      },
    };
    const input = {
      now: "2026-10-30T00:00:00Z",
      entries: ["a", "b"].map((key) => ({ key, kind: "fact", subject: "Synthetic", content: "same", status: "active", expires_at: null })),
    };
    const definition = text([
      { ...baseStep, id: "retrieve", input: { from: "invocation" }, inputSchema: manifest.inputSchema, outputSchema: manifest.inputSchema },
      { ...baseStep, id: "plan", kind: "script", action: "plan_memory_cleanup", input: { from: "step", step: "retrieve" },
        inputSchema: manifest.inputSchema, outputSchema: manifest.outputSchema },
      { ...baseStep, id: "check", kind: "validate", maxAttempts: 2, input: { from: "step", step: "plan" },
        outputSchema: { type: "object", properties: { reviewed: { type: "boolean", enum: [true] } }, required: ["reviewed"], additionalProperties: false } },
      { ...baseStep, id: "choose", kind: "choice",
        outputSchema: { type: "object", properties: { selection: { type: "string", enum: ["keep", "archive"] } },
          required: ["selection"], additionalProperties: false } },
      { ...baseStep, id: "apply", action: "archive", effect: "write", input: { from: "step", step: "choose" } },
    ], manifest.inputSchema);
    for (let attempt = 0; attempt < 10; attempt++) {
      let checks = 0;
      const archived: string[] = [];
      const runtime = new BoundedWorkflowRuntime(store(), {
        async execute(step, value, stepSignal) {
          if (step.id === "retrieve") return stepOutput(input);
          if (step.id === "plan") {
            const inputJson = JSON.stringify(value);
            const scope = { agentId: "synthetic", runId: `mixed-${attempt}`, workspace: stagingRoot.path };
            const consent = new SkillRunConsent(scope, stepSignal);
            const binding = {
              ...scope, artifactRevision: artifact.revision, inputDigest: skillInvocationDigest(inputJson),
              runtimeVersion: process.version, timeoutMs: manifest.timeoutMs, maxOutputBytes: manifest.maxOutputBytes,
            };
            const proposal = consent.propose(binding);
            consent.decide(proposal.id, "approve");
            try {
              const result = await runStagedSkill({
                artifact, inputJson, binding, consent, proposalId: proposal.id, signal: stepSignal,
                policy: () => ({ executeAllowed: true, safeMode: false, blocked: false }), owner: processOwner,
              });
              expect(result).toMatchObject({ status: "succeeded", cleanupVerified: true });
              if (result.status !== "succeeded") return { kind: "unknown" };
              expect(result.output).toEqual(planMemoryCleanup(value));
              return { ...stepOutput(result.output), origin: "script" };
            } finally { consent.close(); }
          }
          if (step.id === "check") {
            expect(value).toMatchObject({ ok: true, duplicate_groups: [["a", "b"]] });
            return { ...stepOutput({ reviewed: ++checks !== 1 }), origin: "deterministic" };
          }
          expect(value).toEqual({ selection: "archive" });
          archived.push("b");
          return stepOutput({ archived: [...archived] });
        },
      });
      const created = runtime.create(definition, JSON.stringify(input));
      const paused = await runtime.advance(created.id, signal());
      expect(runtime.inspect(created.id).state).toMatchObject({ phase: "waiting", retries: 1, next: 3 });
      runtime.answer(created.id, paused.version, created.revision, "choose", '{"selection":"archive"}');
      expect(JSON.parse((await runtime.advance(created.id, signal())).state)).toMatchObject({ phase: "completed", next: 5 });
      expect(archived).toEqual(["b"]);
      expect(() => runtime.answer(created.id, paused.version, created.revision, "choose", '{"selection":"archive"}')).toThrow(/stale/);
    }
  });

  it("persists choices across actual database close/reopen and rejects invalid/stale answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarela-workflow-restart-"));
    paths.push(dir);
    const path = join(dir, "workflow.db");
    const first = new BoundedWorkflowRuntime(store(path), { execute: async () => stepOutput({}) });
    const created = first.create(text([{ ...baseStep, kind: "choice", outputSchema: {
      type: "object", properties: { selected: { type: "boolean", enum: [true] } }, required: ["selected"], additionalProperties: false,
    } }]));
    const paused = await first.advance(created.id, signal());
    first.store.database.close();
    const external = spawnSync(process.execPath, ["-e", `
      const {DatabaseSync} = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      const row = db.prepare('SELECT state FROM bounded_workflow_runs WHERE id=?').get(process.argv[2]);
      if (JSON.parse(row.state).phase !== 'waiting') process.exitCode = 1;
      db.close();
    `, path, created.id], { env: {}, shell: false, timeout: 5000 });
    expect(external.error).toBeUndefined();
    expect(external.status).toBe(0);
    const second = new BoundedWorkflowRuntime(store(path), { execute: vi.fn() });
    expect(second.inspect(created.id).state.phase).toBe("waiting");
    expect(() => second.answer(created.id, paused.version, "0".repeat(64), "first", '{"selected":true}')).toThrow(/stale/);
    expect(() => second.answer(created.id, paused.version, created.revision, "first", '{"selected":false}')).toThrow();
    expect(JSON.parse(second.answer(created.id, paused.version, created.revision, "first", '{"selected":true}').state).phase).toBe("completed");
    expect(() => second.answer(created.id, paused.version, created.revision, "first", '{"selected":true}')).toThrow(/stale/);
  });

  it("uses compare-and-swap to allow exactly one owner claim", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((done) => { release = done; });
    const execute = vi.fn(async () => { await blocked; return stepOutput({}); });
    const db = store();
    const first = new BoundedWorkflowRuntime(db, { execute });
    const second = new BoundedWorkflowRuntime(db, { execute });
    const created = first.create(text([baseStep]));
    const running = first.advance(created.id, signal());
    await expect(second.advance(created.id, signal())).rejects.toThrow(/not ready/);
    release();
    expect(JSON.parse((await running).state).phase).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
    expect(() => db.save(created, created.state)).toThrow(/changed/);
  });

  it("never retries an uncertain write, and requires validated observed reconciliation", async () => {
    const execute = vi.fn(async () => ({ kind: "unknown" as const }));
    const runtime = new BoundedWorkflowRuntime(store(), { execute });
    const created = runtime.create(text([{ ...baseStep, effect: "write", outputSchema: {
      type: "object", properties: { saved: { type: "boolean", enum: [true] } }, required: ["saved"], additionalProperties: false,
    } }]));
    const uncertain = await runtime.advance(created.id, signal());
    expect(JSON.parse(uncertain.state).phase).toBe("uncertain");
    await expect(runtime.advance(created.id, signal())).rejects.toThrow(/not ready/);
    expect(() => runtime.reconcile(created.id, uncertain.version, { outputJson: "{}", evidence: "Observed read-back" })).toThrow();
    expect(JSON.parse(runtime.reconcile(created.id, uncertain.version, {
      outputJson: '{"saved":true}', evidence: "Observed synthetic read-back confirms saved=true",
    }).state).phase).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("requires a dead previous owner to recover interrupted work; writes stay uncertain", async () => {
    for (const effect of ["read", "write"]) {
      const db = store();
      const runtime = new BoundedWorkflowRuntime(db, { execute: vi.fn() });
      const created = runtime.create(text([{ ...baseStep, effect, maxAttempts: effect === "read" ? 2 : 1 }]));
      const state = JSON.parse(created.state);
      state.phase = "running"; state.steps[0].status = "running"; state.steps[0].attempts = 1;
      const interrupted = db.save(created, JSON.stringify(state));
      const next = new BoundedWorkflowRuntime(db, { execute: async () => stepOutput({}) });
      await expect(next.recover(created.id, interrupted.version, async () => false)).rejects.toThrow(/dead owner/);
      const recovered = await next.recover(created.id, interrupted.version, async () => true);
      expect(JSON.parse(recovered.state).phase).toBe(effect === "write" ? "uncertain" : "ready");
      if (effect === "read") expect(JSON.parse((await next.advance(created.id, signal())).state).phase).toBe("completed");
    }
  });

  it("does not execute invalid bindings or inputs, and preserves model-generated labels", async () => {
    const execute = vi.fn(async () => ({ ...stepOutput({}), origin: "model_generated" as const }));
    const runtime = new BoundedWorkflowRuntime(store(), { execute });
    const created = runtime.create(text([
      baseStep,
      { ...baseStep, id: "second", input: { from: "step", step: "first", path: ["missing"] } },
    ]));
    const result = JSON.parse((await runtime.advance(created.id, signal())).state);
    expect(result).toMatchObject({ phase: "failed", error: "input_validation_failed", next: 1 });
    expect(result.steps[0].origin).toBe("model_generated");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("bounds retries across steps and never retries denial", async () => {
    for (const denied of [true, false]) {
      const execute = vi.fn(async () => ({ kind: denied ? "denied" as const : "retryable" as const }));
      const runtime = new BoundedWorkflowRuntime(store(), { execute });
      const created = runtime.create(text([{ ...baseStep, maxAttempts: 3 }]));
      const result = JSON.parse((await runtime.advance(created.id, signal())).state);
      expect(result.phase).toBe("failed");
      expect(execute).toHaveBeenCalledTimes(denied ? 1 : 3);
      expect(result.retries).toBe(denied ? 0 : 2);
    }
  });

  it("enforces the shared six-retry budget across otherwise independent steps", async () => {
    const attempts = new Map<string, number>();
    const runtime = new BoundedWorkflowRuntime(store(), {
      async execute(step) {
        const attempt = (attempts.get(step.id) ?? 0) + 1;
        attempts.set(step.id, attempt);
        return attempt < 3 ? { kind: "retryable" } : stepOutput({});
      },
    });
    const created = runtime.create(text(Array.from({ length: 4 }, (_, index) => ({
      ...baseStep, id: `step${index}`, maxAttempts: 3,
    }))));
    const result = JSON.parse((await runtime.advance(created.id, signal())).state);
    expect(result).toMatchObject({ phase: "failed", next: 3, retries: 6 });
    expect(attempts.get("step3")).toBe(1);
  });

  it("rejects prototype/inherited bindings, malformed stored state and oversized persistence", async () => {
    const db = store();
    const runtime = new BoundedWorkflowRuntime(db, { execute: async () => stepOutput({}) });
    const created = runtime.create(text([
      baseStep, { ...baseStep, id: "second", input: { from: "step", step: "first", path: ["constructor"] } },
    ]));
    expect(JSON.parse((await runtime.advance(created.id, signal())).state).error).toBe("input_validation_failed");
    const fresh = runtime.create(text([baseStep]));
    expect(() => db.save(fresh, "\u00e9".repeat(262145))).toThrow(/512 KiB/);
    db.database.prepare("UPDATE bounded_workflow_runs SET state=? WHERE id=?")
      .run(JSON.stringify({ ...JSON.parse(fresh.state), phase: "completed" }), fresh.id);
    expect(() => runtime.inspect(fresh.id)).toThrow(/completion/);
  });

  it("prevents a late write result from replacing cancellation's uncertain state", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((done) => { release = done; });
    const runtime = new BoundedWorkflowRuntime(store(), {
      async execute() { await blocked; return stepOutput({ saved: true }); },
    });

    const created = runtime.create(text([{ ...baseStep, effect: "write" }]));
    const running = runtime.advance(created.id, signal());
    const active = runtime.inspect(created.id).row;
    const cancelled = runtime.cancel(created.id, active.version);
    expect(JSON.parse(cancelled.state)).toMatchObject({ phase: "uncertain", error: "cancelled_write_requires_reconciliation" });
    release();
    await expect(running).rejects.toThrow(/changed/);
    expect(runtime.inspect(created.id).state.phase).toBe("uncertain");
  });

  it("fails safely when checked outputs would exceed the durable state budget", async () => {
    const runtime = new BoundedWorkflowRuntime(store(), {
      async execute() { return stepOutput({ text: "x".repeat(60000) }); },
    });
    const created = runtime.create(text(Array.from({ length: 10 }, (_, index) => ({ ...baseStep, id: `step${index}` }))));
    const result = JSON.parse((await runtime.advance(created.id, signal())).state);
    expect(result).toMatchObject({ phase: "failed", error: "state_budget_exhausted" });
    expect(result.next).toBeLessThan(10);
    expect(Buffer.byteLength(runtime.inspect(created.id).row.state)).toBeLessThanOrEqual(512 * 1024);
  });

  it("cancels before starting and times out hanging writes as uncertain", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => stepOutput({}));
    const runtime = new BoundedWorkflowRuntime(store(), { execute });
    const created = runtime.create(text([baseStep]));
    expect(JSON.parse((await runtime.advance(created.id, controller.signal)).state).phase).toBe("cancelled");
    expect(execute).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const host: WorkflowHost = { execute: async () => new Promise(() => {}) };
    const second = new BoundedWorkflowRuntime(store(), host);
    const write = second.create(text([{ ...baseStep, effect: "write" }]));
    const running = second.advance(write.id, signal());
    await vi.advanceTimersByTimeAsync(1001);
    expect(JSON.parse((await running).state).phase).toBe("uncertain");
  });

  it("blocks direct reconciliation and recovery until a timed-out host settles", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const runtime = new BoundedWorkflowRuntime(store(), { execute: () => new Promise((resolve) => {
      finish = () => resolve(stepOutput({ saved: true }));
    }) });
    const created = runtime.create(text([{ ...baseStep, effect: "write" }]));
    const advancing = runtime.advance(created.id, signal());
    await vi.advanceTimersByTimeAsync(1000);
    const uncertain = await advancing;
    const observed = { outputJson: '{"saved":true}', evidence: "Fresh observed read-back" };
    const sibling = new BoundedWorkflowRuntime(runtime.store, runtime.host, runtime.owner);
    expect(() => sibling.reconcile(created.id, uncertain.version, observed)).toThrow(/still in flight/);
    expect(() => runtime.reconcile(created.id, uncertain.version, observed)).toThrow(/still in flight/);
    await expect(runtime.recover(created.id, uncertain.version, async () => true)).rejects.toThrow(/still in flight/);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.inspect(created.id).row.version).toBe(uncertain.version);
    expect(JSON.parse(runtime.reconcile(created.id, uncertain.version, observed).state).phase).toBe("completed");
  });
});
