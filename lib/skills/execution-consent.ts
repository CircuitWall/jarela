import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { assertBoundedSkillJson } from "./execution-manifest";

export const SKILL_CONSENT_TTL_MS = 5 * 60 * 1000;
export const SKILL_CONSENT_MAX_PROPOSALS = 64;
const identifier = z.string().min(1).max(240).refine((value) => value === value.trim(), "Identifier must not have surrounding whitespace");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.strictObject({
  agentId: identifier,
  runId: identifier,
  workspace: z.string().min(1).max(4096).refine(isAbsolute, "Workspace must be an absolute resolved path"),
});
const bindingSchema = scopeSchema.extend({
  artifactRevision: digest,
  inputDigest: digest,
  runtimeVersion: identifier,
  timeoutMs: z.number().int().min(1000).max(120_000),
  maxOutputBytes: z.number().int().min(1).max(256 * 1024),
});

export type SkillConsentScope = z.infer<typeof scopeSchema>;
export type SkillConsentBinding = Readonly<z.infer<typeof bindingSchema>>;
export type SkillConsentStatus = "pending" | "approved" | "denied" | "expired" | "cancelled" | "consumed" | "stale";
export type SkillConsentProposal = Readonly<{
  id: string;
  binding: SkillConsentBinding;
  createdAt: number;
  expiresAt: number;
  status: SkillConsentStatus;
}>;
type ConsentEntry = { proposal: SkillConsentProposal; status: SkillConsentStatus; deadline: number };

// Hash exact transport bytes: even semantically equivalent edits require fresh consent.
export function skillInvocationDigest(inputJson: string): string {
  if (Buffer.byteLength(inputJson, "utf8") > 64 * 1024) throw new Error("Invocation exceeds 64 KiB");
  const raw: unknown = JSON.parse(inputJson);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invocation must be a JSON object");
  assertBoundedSkillJson(raw, "Invocation");
  return createHash("sha256").update(inputJson, "utf8").digest("hex");
}

/**
 * Run-local transition contract, not an approval endpoint or execution permission.
 * The eventual runner must supply a verified snapshot digest and resolved workspace,
 * route decisions through pending_actions, and recheck policy immediately before spawn.
 */
export class SkillRunConsent {
  readonly #scope: Readonly<SkillConsentScope>;
  readonly #entries = new Map<string, ConsentEntry>();
  readonly #signal: AbortSignal;
  #closed = false;
  readonly #abort = () => this.close();

  constructor(scope: SkillConsentScope, signal: AbortSignal) {
    this.#scope = Object.freeze(scopeSchema.parse(scope));
    this.#signal = signal;
    if (signal.aborted) this.close();
    else signal.addEventListener("abort", this.#abort, { once: true });
  }

  propose(binding: SkillConsentBinding): SkillConsentProposal {
    this.#assertOpen();
    const checked = Object.freeze(bindingSchema.parse(binding));
    if (!this.#sameScope(checked)) throw new Error("Consent binding does not belong to this run");
    if (this.#entries.size >= SKILL_CONSENT_MAX_PROPOSALS) throw new Error("Skill consent proposal limit reached for this run");
    // At most one outstanding proposal per run; changing the artifact needs new consent.
    for (const entry of this.#entries.values()) {
      this.#expire(entry);
      if (entry.status === "pending" || entry.status === "approved") entry.status = "stale";
    }
    const createdAt = Date.now();
    const proposal = Object.freeze({
      id: randomUUID(), binding: checked, createdAt, expiresAt: createdAt + SKILL_CONSENT_TTL_MS,
      status: "pending" as const,
    });
    this.#entries.set(proposal.id, { proposal, status: "pending", deadline: performance.now() + SKILL_CONSENT_TTL_MS });
    return proposal;
  }

  inspect(id: string): SkillConsentProposal {
    const entry = this.#entry(id);
    this.#expire(entry);
    return Object.freeze({ ...entry.proposal, status: entry.status });
  }

  decide(id: string, decision: "approve" | "deny"): SkillConsentProposal {
    this.#assertOpen();
    if (decision !== "approve" && decision !== "deny") throw new Error("Invalid consent decision");
    const entry = this.#entry(id);
    this.#expire(entry);
    if (entry.status !== "pending") throw new Error(`Consent is ${entry.status}; decision rejected`);
    entry.status = decision === "approve" ? "approved" : "denied";
    return this.inspect(id);
  }

  consume(id: string, binding: SkillConsentBinding, policy: { executeAllowed: boolean; safeMode: boolean }): SkillConsentBinding {
    this.#assertOpen();
    const entry = this.#entry(id);
    this.#expire(entry);
    if (entry.status !== "approved") throw new Error(`Consent is ${entry.status}; execution rejected`);
    if (policy.executeAllowed !== true || policy.safeMode !== false) {
      entry.status = "cancelled";
      throw new Error("Skill execution requires execute capability and safe mode off");
    }
    const checked = bindingSchema.safeParse(binding);
    if (!checked.success || !this.#sameScope(checked.data)
      || (Object.keys(entry.proposal.binding) as Array<keyof SkillConsentBinding>)
        .some((key) => checked.data[key] !== entry.proposal.binding[key])) {
      entry.status = "stale";
      throw new Error("Skill execution binding changed; fresh consent required");
    }
    // Synchronous transition: only one caller can claim this consent in this instance.
    entry.status = "consumed";
    return entry.proposal.binding;
  }

  close(): void {
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#abort);
    for (const entry of this.#entries.values()) {
      this.#expire(entry);
      if (entry.status === "pending" || entry.status === "approved") entry.status = "cancelled";
    }
  }

  #sameScope(binding: SkillConsentScope): boolean {
    return binding.agentId === this.#scope.agentId && binding.runId === this.#scope.runId
      && binding.workspace === this.#scope.workspace;
  }

  #assertOpen(): void {
    if (this.#closed || this.#signal.aborted) throw new Error("Skill run is closed; fresh consent required");
  }

  #entry(id: string): ConsentEntry {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error("Consent does not belong to this run instance");
    return entry;
  }

  #expire(entry: ConsentEntry): void {
    if ((entry.status === "pending" || entry.status === "approved") && performance.now() >= entry.deadline) {
      entry.status = "expired";
    }
  }
}
