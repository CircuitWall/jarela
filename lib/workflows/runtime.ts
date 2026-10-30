import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WorkflowRunStore, type WorkflowRunRow } from "@/lib/stores/workflow-runs";
import { validateSkillInvocation, validateSkillResult, type SkillJsonValue } from "@/lib/skills/execution-protocol";
import { parseWorkflowDefinition, resolveWorkflowInput, type WorkflowStep } from "./definition";

export const WORKFLOW_PRODUCTION_ACTIVATION_AVAILABLE = true;
const stepStateSchema = z.strictObject({
  id: z.string(), attempts: z.number().int().min(0).max(3),
  status: z.enum(["pending", "running", "waiting", "done", "failed", "uncertain", "cancelled"]),
  output: z.json().optional(), evidence: z.string().min(1).max(500).optional(),
  origin: z.enum(["tool", "script", "deterministic", "model_generated", "human"]).optional(),
});
const stateSchema = z.strictObject({
  definition: z.string().max(65536),
  invocationJson: z.string().max(65536),
  next: z.number().int().min(0).max(32), retries: z.number().int().min(0).max(6),
  phase: z.enum(["ready", "running", "waiting", "uncertain", "completed", "failed", "cancelled"]),
  steps: z.array(stepStateSchema).min(1).max(32),
  error: z.string().max(120).optional(),
});
type WorkflowState = z.infer<typeof stateSchema>;

const adapterResult = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("output"), json: z.string().max(65536), evidence: z.string().min(1).max(500),
    origin: z.enum(["tool", "script", "deterministic", "model_generated"]),
  }),
  z.strictObject({ kind: z.enum(["retryable", "denied", "unknown"]) }),
]);
export type WorkflowAdapterResult = z.infer<typeof adapterResult>;
export interface WorkflowHost {
  execute(step: WorkflowStep, input: SkillJsonValue, signal: AbortSignal): Promise<WorkflowAdapterResult>;
}

function decode(row: WorkflowRunRow) {
  const raw: unknown = JSON.parse(row.state);
  const pending = [{ value: raw, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 131072 || current.depth > 40) throw new Error("Persisted workflow state exceeds JSON complexity limits");
    if (current.value && typeof current.value === "object") {
      for (const value of Object.values(current.value)) pending.push({ value, depth: current.depth + 1 });
    }
  }
  const state = stateSchema.parse(raw);
  const definition = parseWorkflowDefinition(state.definition);
  const invocation = validateSkillInvocation(definition.inputContract, state.invocationJson);
  if (definition.revision !== row.revision || state.steps.length !== definition.steps.length
    || state.next > state.steps.length || state.steps.some((step, index) => step.id !== definition.steps[index].id)) {
    throw new Error("Persisted workflow identity is invalid");
  }
  const outputs = new Map<string, SkillJsonValue>();
  for (let index = 0; index < state.steps.length; index++) {
    const step = state.steps[index];
    if (step.attempts > definition.steps[index].maxAttempts) throw new Error("Persisted workflow attempt budget is invalid");
    if (index < state.next) {
      if (step.status !== "done" || !Object.hasOwn(step, "output") || !step.evidence || !step.origin) {
        throw new Error("Persisted workflow progress has no checked output evidence");
      }
      const output = validateSkillResult(definition.steps[index].contract, JSON.stringify(step.output));
      outputs.set(step.id, output);
    } else if (step.status === "done" || Object.hasOwn(step, "output")) {
      throw new Error("Persisted workflow progress is out of order");
    }
  }
  if ((state.phase === "completed") !== (state.next === state.steps.length)) {
    throw new Error("Persisted workflow completion is inconsistent");
  }
  if (state.next < state.steps.length) {
    const current = state.steps[state.next];
    if (state.phase === "waiting" && (current.status !== "waiting" || definition.steps[state.next].kind !== "choice")
      || state.phase === "running" && current.status !== "running"
      || state.phase === "ready" && current.status !== "pending"
      || state.phase === "uncertain" && (current.status !== "uncertain" || definition.steps[state.next].effect !== "write")) {
      throw new Error("Persisted workflow phase is inconsistent");
    }
  }
  return { state, definition, outputs, invocation };
}

// Host adapters remain responsible for capability checks, consent and process
// ownership. This coordinator cannot turn a choice response into authorization.
const executionHost = globalThis as typeof globalThis & { __jarelaWorkflowExecutions?: Map<string, Promise<void>> };
export const workflowExecutions = executionHost.__jarelaWorkflowExecutions ??= new Map<string, Promise<void>>();

export class BoundedWorkflowRuntime {
  readonly #active = new Map<string, AbortController>();
  constructor(
    readonly store: WorkflowRunStore,
    readonly host: WorkflowHost,
    readonly owner: string = randomUUID(),
  ) {}

  assertExecutionSettled(id: string): void {
    if (workflowExecutions.has(id)) throw new Error("Workflow execution is still in flight; wait for settlement before reconciliation or continuation");
  }

  create(definitionText: string, invocationJson = "{}"): WorkflowRunRow {
    const definition = parseWorkflowDefinition(definitionText);
    validateSkillInvocation(definition.inputContract, invocationJson);
    const state: WorkflowState = {
      definition: definitionText, invocationJson, next: 0, retries: 0, phase: "ready",
      steps: definition.steps.map((step) => ({ id: step.id, attempts: 0, status: "pending" })),
    };
    return this.store.create({ id: randomUUID(), revision: definition.revision, owner: this.owner, state: JSON.stringify(state) });
  }

  inspect(id: string) {
    const row = this.store.get(id);
    const { state, definition, outputs, invocation } = decode(row);
    const choice = state.phase === "waiting"
      ? resolveWorkflowInput(definition.steps[state.next], outputs, invocation) : undefined;
    return { row, state, choice };
  }

  async advance(id: string, signal: AbortSignal): Promise<WorkflowRunRow> {
    let row = this.store.get(id);
    const { state, definition, outputs, invocation } = decode(row);
    if (state.phase !== "ready") throw new Error("Workflow is not ready; reconcile, answer or recover before advancing");
    this.assertExecutionSettled(id);
    for (; state.next < definition.steps.length;) {
      const step = definition.steps[state.next];
      const progress = state.steps[state.next];
      if (signal.aborted) {
        state.phase = "cancelled"; progress.status = "cancelled";
        return this.store.save(row, JSON.stringify(state), this.owner);
      }
      let input: SkillJsonValue;
      try {
        input = resolveWorkflowInput(step, outputs, invocation);
        validateSkillInvocation(step.contract, JSON.stringify(input));
      } catch {
        state.phase = "failed"; state.error = "input_validation_failed"; progress.status = "failed";
        return this.store.save(row, JSON.stringify(state), this.owner);
      }
      if (step.kind === "choice") {
        state.phase = "waiting"; progress.status = "waiting";
        return this.store.save(row, JSON.stringify(state), this.owner);
      }
      if (progress.attempts >= step.maxAttempts) {
        state.phase = "failed"; state.error = "attempt_budget_exhausted"; progress.status = "failed";
        return this.store.save(row, JSON.stringify(state), this.owner);
      }
      state.phase = "running"; progress.status = "running"; progress.attempts++;
      row = this.store.save(row, JSON.stringify(state), this.owner);
      const controller = new AbortController();
      this.#active.set(id, controller);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      let result: WorkflowAdapterResult;
      try {
        const interrupted = new Promise<never>((_, reject) => {
          abort = () => { controller.abort(); reject(new Error("Workflow cancelled")); };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          timer = setTimeout(() => {
            controller.abort(); reject(new Error("Workflow step timed out"));
          }, step.timeoutMs);
        });
        const work = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error("Workflow interrupted before host execution");
          return this.host.execute(step, input, controller.signal);
        });
        const release = () => {
          if (workflowExecutions.get(id) === settled) workflowExecutions.delete(id);
        };
        const settled = work.then(release, release);
        workflowExecutions.set(id, settled);
        result = adapterResult.parse(await Promise.race([work, interrupted]));
      } catch {
        state.phase = step.effect === "write" ? "uncertain" : signal.aborted ? "cancelled" : "failed";
        progress.status = state.phase;
        state.error = "step_interrupted_or_failed";
        return this.store.save(row, JSON.stringify(state));
      } finally {
        clearTimeout(timer);
        if (abort) signal.removeEventListener("abort", abort);
        this.#active.delete(id);
      }
      if (signal.aborted || result.kind === "unknown") {
        state.phase = step.effect === "write" ? "uncertain" : signal.aborted ? "cancelled" : "failed";
        progress.status = state.phase; state.error = "step_outcome_unverified";
        return this.store.save(row, JSON.stringify(state));
      }
      if (result.kind === "denied") {
        state.phase = "failed"; progress.status = "failed"; state.error = "denied";
        return this.store.save(row, JSON.stringify(state));
      }
      let output: SkillJsonValue | undefined;
      let validOutput = false;
      if (result.kind === "output") {
        try {
          output = validateSkillResult(step.contract, result.json);
          validOutput = true;
        } catch { state.error = "output_validation_failed"; }
      }
      if (!validOutput || result.kind !== "output") {
        if (step.effect === "read" && progress.attempts < step.maxAttempts && state.retries < 6) {
          state.retries++; state.phase = "ready"; progress.status = "pending";
          row = this.store.save(row, JSON.stringify(state));
          continue;
        }
        state.phase = step.effect === "write" ? "uncertain" : "failed";
        progress.status = state.phase; state.error ??= "step_failed";
        return this.store.save(row, JSON.stringify(state));
      }
      progress.output = output!; progress.evidence = result.evidence; progress.origin = result.origin;
      progress.status = "done"; state.next++;
      state.phase = state.next === definition.steps.length ? "completed" : "ready";
      delete state.error;
      outputs.set(step.id, output!);
      try {
        row = this.store.save(row, JSON.stringify(state));
      } catch (error) {
        if (Buffer.byteLength(JSON.stringify(state), "utf8") <= 512 * 1024) throw error;
        delete progress.output; delete progress.evidence; delete progress.origin;
        state.next--; state.phase = step.effect === "write" ? "uncertain" : "failed";
        progress.status = state.phase; state.error = "state_budget_exhausted";
        return this.store.save(row, JSON.stringify(state));
      }
    }
    return row;
  }

  answer(id: string, expectedVersion: number, revision: string, stepId: string, answerJson: string): WorkflowRunRow {
    const row = this.store.get(id);
    const { state, definition } = decode(row);
    if (row.version !== expectedVersion || row.revision !== revision || state.phase !== "waiting"
      || definition.steps[state.next]?.id !== stepId) throw new Error("Choice is stale, duplicate or belongs to another step");
    const output = validateSkillResult(definition.steps[state.next].contract, answerJson);
    const step = state.steps[state.next];
    step.output = output; step.evidence = "Validated human answer; not execution consent";
    step.origin = "human"; step.status = "done"; state.next++;
    state.phase = state.next === definition.steps.length ? "completed" : "ready";
    return this.store.save(row, JSON.stringify(state), this.owner);
  }

  async recover(id: string, expectedVersion: number, priorOwnerIsDead: (owner: string) => Promise<boolean>): Promise<WorkflowRunRow> {
    this.assertExecutionSettled(id);
    const row = this.store.get(id);
    const { state, definition } = decode(row);
    if (row.version !== expectedVersion || state.phase !== "running" || !(await priorOwnerIsDead(row.owner))) {
      throw new Error("Workflow recovery requires the exact interrupted state and a verified dead owner");
    }
    const step = state.steps[state.next];
    const declared = definition.steps[state.next];
    state.phase = declared.effect === "write" ? "uncertain" : step.attempts < declared.maxAttempts && state.retries < 6 ? "ready" : "failed";
    step.status = state.phase === "ready" ? "pending" : state.phase;
    if (state.phase === "ready") state.retries++;
    state.error = "interrupted_owner_recovered";
    return this.store.save(row, JSON.stringify(state), this.owner);
  }

  reconcile(id: string, expectedVersion: number, observed: { outputJson: string; evidence: string }): WorkflowRunRow {
    this.assertExecutionSettled(id);
    const row = this.store.get(id);
    const { state, definition } = decode(row);
    if (row.version !== expectedVersion || state.phase !== "uncertain") throw new Error("Workflow reconciliation is stale or unnecessary");
    const evidence = z.string().min(1).max(500).parse(observed.evidence);
    const progress = state.steps[state.next];
    progress.output = validateSkillResult(definition.steps[state.next].contract, observed.outputJson);
    progress.evidence = evidence; progress.origin = "tool"; progress.status = "done";
    state.next++; state.phase = state.next === definition.steps.length ? "completed" : "ready";
    delete state.error;
    return this.store.save(row, JSON.stringify(state), this.owner);
  }

  cancel(id: string, expectedVersion: number): WorkflowRunRow {
    const row = this.store.get(id);
    const { state, definition } = decode(row);
    if (row.version !== expectedVersion || ["completed", "failed", "cancelled"].includes(state.phase)) {
      throw new Error("Workflow cancellation is stale or terminal");
    }
    const progress = state.steps[state.next];
    const uncertain = state.phase === "uncertain" || (state.phase === "running" && definition.steps[state.next].effect === "write");
    state.phase = uncertain ? "uncertain" : "cancelled"; progress.status = state.phase;
    state.error = uncertain ? "cancelled_write_requires_reconciliation" : "cancelled";
    const saved = this.store.save(row, JSON.stringify(state), this.owner);
    this.#active.get(id)?.abort();
    return saved;
  }
}
