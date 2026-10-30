import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { cleanupWorkflowRuns, DurableWorkflowRunStore, type WorkflowRunRow } from "@/lib/stores/workflow-runs";
import type { SkillJsonValue } from "@/lib/skills/execution-protocol";
import { BoundedWorkflowRuntime, workflowExecutions, type WorkflowAdapterResult } from "./runtime";
import { parseWorkflowDefinition, resolveWorkflowInput, type WorkflowStep } from "./definition";
import { requestWorkflowAuthorization, revokeWorkflowAuthorizations } from "./authorization";
import { currentProcessOwner, isProcessOwnerDead, ProcessOwnerSchema, type ProcessOwner } from "@/lib/lifecycle/process-ownership";

export interface WorkflowHostContext {
  agentId: string;
  workspace: string;
  runId: string;
}
export interface WorkflowExecutionContext extends WorkflowHostContext {
  revision: string;
  stepId: string;
  version: number;
  invocationJson: string;
}
export interface WorkflowPreparationContext extends WorkflowHostContext {
  revision: string;
  version: number;
  definitionText: string;
  invocationJson: string;
}
const preparationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({
    kind: z.literal("approval_required"), proposalId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200).optional(),
  }),
]);
export type WorkflowPreparation = z.infer<typeof preparationSchema>;
export interface WorkflowHostAdapter {
  prepare?(context: WorkflowPreparationContext, signal: AbortSignal): Promise<WorkflowPreparation>;
  execute(step: WorkflowStep, input: SkillJsonValue, signal: AbortSignal, context: WorkflowExecutionContext): Promise<WorkflowAdapterResult>;
  observe?(step: WorkflowStep, input: SkillJsonValue, signal: AbortSignal, context: WorkflowExecutionContext): Promise<{ outputJson: string; evidence: string }>;
}
export type WorkflowHostFactory = (context: WorkflowHostContext) => WorkflowHostAdapter | Promise<WorkflowHostAdapter>;
const ownerSchema = ProcessOwnerSchema;
export type WorkflowOwner = ProcessOwner;
type ActiveWorkflow = { runtime: BoundedWorkflowRuntime; controller: AbortController; done: Promise<void> };
type Globals = {
  owner: WorkflowOwner;
  factory?: WorkflowHostFactory;
  services: WeakMap<DatabaseSync, WorkflowService>;
  activeServices?: Set<WorkflowService>;
  active?: Map<string, ActiveWorkflow>;
};
const globalsHost = globalThis as typeof globalThis & { __jarelaWorkflows?: Globals };
const globals = globalsHost.__jarelaWorkflows ??= {
  owner: currentProcessOwner(), services: new WeakMap(),
};

export function installWorkflowHostFactory(factory: WorkflowHostFactory): void {
  globals.factory = factory;
}

async function defaultHost(context: WorkflowHostContext): Promise<WorkflowHostAdapter> {
  if (globals.factory) return globals.factory(context);
  const { createWorkflowHost } = await import("./host");
  const host: WorkflowHostAdapter = await createWorkflowHost(context);
  return {
    execute: host.execute.bind(host),
    observe: host.observe?.bind(host),
    async prepare(preparation, signal) {
      if (parseWorkflowDefinition(preparation.definitionText).steps.some((step) => step.kind === "script")) {
        const approval = requestWorkflowAuthorization({
          runId: preparation.runId, agentId: preparation.agentId, workspace: preparation.workspace,
          definitionText: preparation.definitionText, invocationJson: preparation.invocationJson,
        });
        if (approval.status === "pending") return preparationSchema.parse({
          kind: "approval_required", proposalId: approval.proposal_id, requestId: approval.authorization_id,
        });
      }
      return host.prepare ? host.prepare(preparation, signal) : { kind: "ready" };
    },
  };
}

// ESRCH is an OS observation, not an expired lease or a guessed restart.
// PID reuse and EPERM remain blocked rather than declaring a live owner dead.
export const attestWorkflowOwnerDead = isProcessOwnerDead;

export class WorkflowService {
  readonly #owner: string;
  readonly #active = globals.active ??= new Map<string, ActiveWorkflow>();
  #closing = false;
  constructor(
    readonly database: DatabaseSync,
    readonly hostFactory: WorkflowHostFactory = defaultHost,
    owner: WorkflowOwner = globals.owner,
    readonly attestDead: (owner: WorkflowOwner) => Promise<boolean> = attestWorkflowOwnerDead,
    readonly revokeAuthorizations: (runId: string) => void = revokeWorkflowAuthorizations,
  ) {
    this.#owner = JSON.stringify(ownerSchema.parse(owner));
  }

  create(agentId: string, definitionText: string, invocationJson: string, workspace: string) {
    this.#open();
    if (!isAbsolute(workspace) || resolve(workspace) !== workspace) throw new Error("Workflow workspace must be an absolute normalized path");
    const store = this.#store(agentId, workspace);
    const runtime = new BoundedWorkflowRuntime(store, { execute: async () => ({ kind: "denied" }) }, this.#owner);
    const row = runtime.create(definitionText, invocationJson);
    return this.inspect(agentId, row.id);
  }

  inspect(agentId: string, id: string) {
    const store = this.#store(agentId);
    const { row, state, choice } = this.#runtime(store, id).inspect(id);
    return {
      id: row.id, agentId, revision: row.revision, version: row.version,
      workspace: store.getWorkspace(id), owner: ownerSchema.parse(JSON.parse(row.owner)),
      phase: state.phase, next: state.next, steps: state.steps, error: state.error,
      ...(choice === undefined ? {} : {
        question: { stepId: state.steps[state.next].id, input: choice,
          outputSchema: parseWorkflowDefinition(state.definition).steps[state.next].outputSchema,
          executionApproval: false as const },
      }),
    };
  }

  list(agentId: string, limit = 50, after?: string) {
    this.cleanup();
    const rows = this.#store(agentId).list(limit, after);
    return rows.map((row) => this.inspect(agentId, row.id));
  }

  cleanup(): number {
    return cleanupWorkflowRuns(this.database);
  }

  async advance(agentId: string, id: string, expectedVersion: number, signal = new AbortController().signal) {
    this.#open();
    const store = this.#store(agentId);
    const prior = this.#expected(store, id, expectedVersion);
    const runtime = this.#runtime(store, id);
    if (JSON.parse(prior.state).phase === "running") {
      await runtime.recover(id, expectedVersion, (owner) => this.#isDead(owner));
      // Recovery never executes a step or resurrects an execution grant.
      this.#settle(store, id);
      return this.inspect(agentId, id);
    }
    const claimed = await this.#claim(store, prior);
    const { state } = runtime.inspect(id);
    if (state.phase !== "ready") throw new Error("Workflow is not ready");
    const definition = parseWorkflowDefinition(state.definition);
    const context = { agentId, workspace: store.getWorkspace(id), runId: id };
    const host = await this.hostFactory(context);
    if (definition.steps.some((step) => step.kind === "script") && !host.prepare) {
      throw new Error("Workflow script plan requires host authorization preflight");
    }
    if (host.prepare) {
      const prepared = preparationSchema.parse(await host.prepare({
        ...context, revision: claimed.revision, version: claimed.version,
        definitionText: state.definition, invocationJson: state.invocationJson,
      }, signal));
      if (prepared.kind === "approval_required") {
        return { ...this.inspect(agentId, id), executionApproval: prepared };
      }
    }
    this.#expected(store, id, claimed.version);
    this.#open();
    if (signal.aborted) throw new Error("Workflow advance cancelled before execution");
    const controller = new AbortController();
    const key = `${agentId}:${id}`;
    if (this.#active.has(key)) throw new Error("Workflow is already executing");
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.#active.set(key, { runtime, controller, done });
    try {
      await runtime.advance(id, AbortSignal.any([signal, controller.signal]));
    } catch (error) {
      const state = JSON.parse(store.get(id).state) as { error?: string };
      if (!controller.signal.aborted || !["cancelled", "cancelled_write_requires_reconciliation", "step_interrupted_or_failed"].includes(state.error ?? "")) throw error;
    } finally { this.#active.delete(key); this.#settle(store, id); finish(); }
    return this.inspect(agentId, id);
  }

  async answer(agentId: string, id: string, answer: {
    version: number; revision: string; stepId: string; answerJson: string;
  }) {
    this.#open();
    const store = this.#store(agentId);
    const row = await this.#claim(store, this.#expected(store, id, answer.version));
    this.#runtime(store, id).answer(id, row.version, answer.revision, answer.stepId, answer.answerJson);
    this.#settle(store, id);
    return this.inspect(agentId, id);
  }

  async cancel(agentId: string, id: string, expectedVersion: number) {
    this.#open();
    const store = this.#store(agentId);
    let row = this.#expected(store, id, expectedVersion);
    const active = this.#active.get(`${agentId}:${id}`);
    const runtime = active?.runtime ?? this.#runtime(store, id);
    if (row.owner !== this.#owner && JSON.parse(row.state).phase === "running") {
      row = await runtime.recover(id, row.version, (owner) => this.#isDead(owner));
    } else row = await this.#claim(store, row);
    runtime.cancel(id, row.version);
    // Cancellation ends script authority even when a write remains uncertain;
    // read-back reconciliation uses the host observe path, not script grants.
    this.revokeAuthorizations(id);
    active?.controller.abort();
    return this.inspect(agentId, id);
  }

  async reconcile(agentId: string, id: string, expectedVersion: number, signal = new AbortController().signal) {
    this.#open();
    const store = this.#store(agentId);
    const row = await this.#claim(store, this.#expected(store, id, expectedVersion));
    const runtime = this.#runtime(store, id);
    runtime.assertExecutionSettled(id);
    const { state } = runtime.inspect(id);
    if (state.phase !== "uncertain") throw new Error("Workflow reconciliation requires an uncertain write");
    const definition = parseWorkflowDefinition(state.definition);
    const step = definition.steps[state.next];
    if (!step.reconcileAction) throw new Error("Workflow write step declares no reconcile read-back action");
    const hostContext = { agentId, workspace: store.getWorkspace(id), runId: id };
    const host = await this.hostFactory(hostContext);
    if (!host.observe) throw new Error("Workflow host cannot attest an observed write outcome");
    const outputs = new Map(state.steps.slice(0, state.next).map((value) => [value.id, value.output!]));
    const input = resolveWorkflowInput(step, outputs, JSON.parse(state.invocationJson));
    this.#expected(store, id, row.version);
    runtime.assertExecutionSettled(id);
    const observed = await host.observe(step, input, signal, {
      ...hostContext, revision: row.revision, stepId: step.id, version: row.version, invocationJson: state.invocationJson,
    });
    if (signal.aborted) throw new Error("Workflow reconciliation cancelled");
    runtime.reconcile(id, row.version, z.strictObject({
      outputJson: z.string().max(65536), evidence: z.string().min(1).max(500),
    }).parse(observed));
    this.#settle(store, id);
    return this.inspect(agentId, id);
  }

  // Shutdown aborts trusted adapters; the coordinator persists read cancellation
  // or write uncertainty and never auto-replays after the next start.
  async shutdown(timeoutMs = 5000): Promise<{ aborted: number; drained: boolean }> {
    z.number().int().min(0).max(30000).parse(timeoutMs);
    this.#closing = true;
    const active = [...this.#active.values()];
    for (const run of active) run.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.all([...active.map((run) => run.done), ...workflowExecutions.values()]).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    clearTimeout(timer);
    return { aborted: active.length, drained };
  }

  // Runs after the terminal state is persisted, or after the run disappeared.
  #settle(store: DurableWorkflowRunStore, id: string) {
    let phase: string | undefined;
    try { phase = (JSON.parse(store.get(id).state) as { phase: string }).phase; }
    catch (error) {
      if (!(error instanceof Error && /not found/.test(error.message))) return;
    }
    if (phase === undefined || ["completed", "failed", "cancelled"].includes(phase)) this.revokeAuthorizations(id);
  }

  #open() {
    if (this.#closing) throw new Error("Workflow service is shutting down");
  }

  #store(agentId: string, workspace?: string) {
    z.string().min(1).max(200).parse(agentId);
    if (!this.database.prepare("SELECT 1 FROM agent_configs WHERE id=?").get(agentId)) throw new Error("Agent not found");
    return new DurableWorkflowRunStore(this.database, agentId, workspace);
  }

  #runtime(store: DurableWorkflowRunStore, id: string) {
    return new BoundedWorkflowRuntime(store, {
      execute: async (step, input, signal) => {
        const row = store.get(id);
        const context = { agentId: store.agentId, workspace: store.getWorkspace(id), runId: id };
        const host = await this.hostFactory(context);
        return host.execute(step, input, signal, {
          ...context, revision: row.revision, stepId: step.id, version: row.version,
          invocationJson: (JSON.parse(row.state) as { invocationJson: string }).invocationJson,
        });
      },
    }, this.#owner);
  }

  #expected(store: DurableWorkflowRunStore, id: string, version: number) {
    z.number().int().positive().parse(version);
    const row = store.get(id);
    if (row.version !== version) throw new Error("Workflow run changed; reload before acting");
    return row;
  }

  async #isDead(owner: string) {
    if (owner === this.#owner) return false;
    const parsed = ownerSchema.parse(JSON.parse(owner));
    if (parsed.pid === process.pid) return false;
    return this.attestDead(parsed);
  }

  async #claim(store: DurableWorkflowRunStore, row: WorkflowRunRow) {
    if (row.owner === this.#owner) return row;
    if (!await this.#isDead(row.owner)) throw new Error("Workflow is owned by a live or unverifiable runtime");
    return store.save(row, row.state, this.#owner);
  }
}

export function getWorkflowService(): WorkflowService {
  const db = getDb();
  let service = globals.services.get(db);
  if (!service) {
    service = new WorkflowService(db);
    globals.services.set(db, service);
    (globals.activeServices ??= new Set()).add(service);
  }
  return service;
}

export async function shutdownWorkflowService(timeoutMs?: number): Promise<{ aborted: number; drained: boolean }> {
  const services = [...(globals.activeServices ?? [])];
  globals.activeServices?.clear();
  const results = await Promise.all(services.map((service) => service.shutdown(timeoutMs)));
  return {
    aborted: results.reduce((total, result) => total + result.aborted, 0),
    drained: results.every((result) => result.drained),
  };
}
