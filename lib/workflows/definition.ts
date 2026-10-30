import { createHash } from "node:crypto";
import { z } from "zod";
import { assertBoundedSkillJson, parseSkillExecutionManifest } from "@/lib/skills/execution-manifest";
import type { SkillJsonValue } from "@/lib/skills/execution-protocol";

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const binding = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("literal"), value: z.json() }),
  z.strictObject({ from: z.literal("step"), step: id, path: z.array(z.string().min(1).max(200)).max(8).default([]) }),
  z.strictObject({ from: z.literal("invocation"), path: z.array(z.string().min(1).max(200)).max(8).default([]) }),
]);
const definitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  inputSchema: z.unknown().optional(),
  steps: z.array(z.strictObject({
    id, kind: z.enum(["tool", "script", "validate", "choice"]),
    action: id,
    reconcileAction: id.optional(),
    effect: z.enum(["read", "write"]),
    input: binding,
    inputSchema: z.unknown(), outputSchema: z.unknown(),
    maxAttempts: z.number().int().min(1).max(3).default(1),
    timeoutMs: z.number().int().min(1000).max(120000).default(60000),
  })).min(1).max(32),
});

export function parseWorkflowDefinition(text: string) {
  if (Buffer.byteLength(text, "utf8") > 65536) throw new Error("Workflow definition exceeds 64 KiB");
  const raw: unknown = JSON.parse(text);
  assertBoundedSkillJson(raw, "Workflow definition");
  const definition = definitionSchema.parse(raw);
  const prior = new Set<string>();
  const steps = definition.steps.map((step) => {
    if (prior.has(step.id)) throw new Error("Workflow step IDs must be unique");
    if (step.input.from === "step" && !prior.has(step.input.step)) {
      throw new Error("Workflow bindings must reference an earlier step");
    }
    if (step.effect === "write" && (step.maxAttempts !== 1 || step.kind !== "tool")) {
      throw new Error("Only single-attempt tool steps may declare writes");
    }
    if (step.reconcileAction !== undefined && (step.effect !== "write" || step.kind !== "tool")) {
      throw new Error("Only write tool steps may declare a reconcile read-back action");
    }
    if (step.kind === "choice" && step.maxAttempts !== 1) throw new Error("Choice steps do not retry");
    if (step.kind === "script" && step.maxAttempts !== 1) throw new Error("Script execution does not automatically retry");
    prior.add(step.id);
    const contract = parseSkillExecutionManifest(JSON.stringify({
      schemaVersion: 1, entrypoint: "entry.mjs", files: ["entry.mjs"],
      inputSchema: step.inputSchema, outputSchema: step.outputSchema, timeoutMs: step.timeoutMs,
    }));
    return { ...step, contract };
  });
  const inputContract = parseSkillExecutionManifest(JSON.stringify({
    schemaVersion: 1, entrypoint: "entry.mjs", files: ["entry.mjs"],
    inputSchema: definition.inputSchema === undefined ? { type: "object", properties: {}, additionalProperties: false } : definition.inputSchema,
    outputSchema: { type: "null" },
  }));
  return { ...definition, steps, inputContract, revision: createHash("sha256").update(text, "utf8").digest("hex") };
}
export type WorkflowDefinition = ReturnType<typeof parseWorkflowDefinition>;
export type WorkflowStep = WorkflowDefinition["steps"][number];

export function resolveWorkflowInput(
  step: WorkflowStep, outputs: ReadonlyMap<string, SkillJsonValue>, invocation: SkillJsonValue,
): SkillJsonValue {
  if (step.input.from === "literal") return structuredClone(step.input.value);
  if (step.input.from === "step" && !outputs.has(step.input.step)) throw new Error("Workflow binding has no validated source");
  let value: SkillJsonValue = step.input.from === "invocation" ? invocation : outputs.get(step.input.step)!;
  for (const key of step.input.path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) {
      throw new Error("Workflow binding path does not exist");
    }
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error("Workflow array path must be a canonical index");
      value = value[Number(key)];
    } else value = value[key];
  }
  return structuredClone(value);
}
