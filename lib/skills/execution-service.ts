import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolveSkill } from "@/lib/skills";
import { getAgentConfig, getAgentTools } from "@/lib/stores/agent-configs";
import { disabledCategories } from "@/lib/stores/builtin-tools";
import { createPendingAction, getPendingAction, setActionStatus } from "@/lib/stores/pending-actions";
import { isMasterKeyLocked } from "@/lib/crypto/master-key";
import { isScreenLocked } from "@/lib/security/screen-lock";
import { resolveSafetyMode } from "@/lib/tools/security/safety";
import { SkillExecutionArtifact } from "./execution-artifact";
import { SkillRunConsent, skillInvocationDigest, SKILL_CONSENT_TTL_MS } from "./execution-consent";
import { resolveSkillExecutionConsentRequirement } from "./execution-policy-server";
import type { SkillExecutionPolicyDecision, SkillExecutionTarget } from "./execution-policy";
import { validateSkillInvocation } from "./execution-protocol";
import { runStagedSkill, type SkillProcessOwner } from "./execution-runner";
import { createSkillProcessOwner, getSkillProcessOwnerAvailability } from "./process-owner";
import { consumeWorkflowScriptAuthorization } from "@/lib/workflows/authorization";

type ExecutionResult = Awaited<ReturnType<typeof runStagedSkill>>;
export interface SkillExecutionRequest {
  agentId: string; skillId: string; inputJson: string; workspace: string;
  workflow?: { runId: string; revision: string; invocationJson: string; stepId: string };
  signal?: AbortSignal;
}
interface Dependencies {
  directory(id: string): string;
  authorize(agentId: string): boolean;
  policy(target: SkillExecutionTarget, allowed: boolean): SkillExecutionPolicyDecision;
  owner(): SkillProcessOwner;
  proposal(agentId: string, payload: Record<string, unknown>): string;
  expire(proposalId: string): void;
}
function identity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error("Workspace must be a canonical unlinked directory");
  }
  return `${stat.dev}:${stat.ino}`;
}
function executionAllowed(agentId: string) {
  const agent = getAgentConfig(agentId);
  return !!agent && getAgentTools(agent).includes("run_skill") && !disabledCategories().has("Skills")
    && !isMasterKeyLocked() && !isScreenLocked();
}

export class SkillExecutionService {
  readonly #active = new Set<Promise<ExecutionResult>>();
  #closed = false;
  readonly #requests = new Map<string, {
    request: SkillExecutionRequest; artifact: SkillExecutionArtifact; workspaceIdentity: string;
    controller: AbortController; consent: SkillRunConsent; proposalId: string;
    binding: Parameters<typeof runStagedSkill>[0]["binding"]; consentId: string;
    status: "pending" | "running" | "finished"; result?: ExecutionResult; error?: string;
    timer: ReturnType<typeof setTimeout>; expiresAt: number;
    completion: Promise<ExecutionResult>; complete(result: ExecutionResult): void; fail(error: Error): void;
  }>();
  constructor(readonly dependencies: Dependencies) {}

  async request(request: SkillExecutionRequest) {
    if (this.#closed) throw new Error("Skill execution service is shutting down");
    if (request.signal?.aborted) throw new Error("Skill execution cancelled");
    if (this.#requests.size >= 16) throw new Error("Skill execution capacity reached; wait for retained requests to expire");
    const artifact = SkillExecutionArtifact.capture(this.dependencies.directory(request.skillId));
    const manifest = artifact.getManifest();
    validateSkillInvocation(manifest, request.inputJson);
    const workspaceIdentity = identity(request.workspace);
    const target = { revision: artifact.revision, agent_id: request.agentId, workspace: request.workspace,
      timeout_ms: manifest.timeoutMs, max_output_bytes: manifest.maxOutputBytes };
    const decision = this.dependencies.policy(target, this.dependencies.authorize(request.agentId));
    if (decision.kind === "blocked") throw new Error(decision.reason);
    // Workflow-wide grants require an independently bound plan. Never substitute
    // an ordinary question, agent assertion, or invocation approval for that grant.
    const workflowApproved = request.workflow !== undefined;
    if (workflowApproved) {
      consumeWorkflowScriptAuthorization({
        ...request.workflow!, agentId: request.agentId, workspace: request.workspace,
        skillId: request.skillId, artifactRevision: artifact.revision,
      });
    }
    if (decision.kind === "require_workflow_consent" && !workflowApproved) throw new Error("Workflow-wide authorization requires a verified workflow plan; use run_workflow or select Ask each time");
    const id = randomUUID();
    const controller = new AbortController();
    const externalAbort = () => {
      controller.abort();
      const current = this.#requests.get(id);
      if (!current || current.status === "finished") return;
      try { this.cancel(id, request.agentId); }
      catch (error) { console.error("[skill-execution] cancellation failed:", error); }
    };
    request.signal?.addEventListener("abort", externalAbort, { once: true });
    const scope = { agentId: request.agentId, runId: id, workspace: request.workspace };
    const consent = new SkillRunConsent(scope, controller.signal);
    const binding = { ...scope, artifactRevision: artifact.revision, inputDigest: skillInvocationDigest(request.inputJson),
      runtimeVersion: process.version, timeoutMs: manifest.timeoutMs, maxOutputBytes: manifest.maxOutputBytes };
    const consentId = consent.propose(binding).id;
    const expiresAt = Date.now() + SKILL_CONSENT_TTL_MS;
    let complete!: (result: ExecutionResult) => void;
    let fail!: (error: Error) => void;
    const completion = new Promise<ExecutionResult>((done, reject) => { complete = done; fail = reject; });
    void completion.then(
      () => request.signal?.removeEventListener("abort", externalAbort),
      () => request.signal?.removeEventListener("abort", externalAbort),
    );
    // A caller need not wait: check_proposal is the ordinary asynchronous path.
    void completion.catch(() => {});
    const timer = setTimeout(() => {
      const entry = this.#requests.get(id);
      if (!entry) return;
      entry.controller.abort();
      entry.consent.close();
      entry.fail(new Error("Skill execution request expired"));
      if (entry.status === "pending") {
        try { this.dependencies.expire(entry.proposalId); }
        catch (error) { console.error("[skill-execution] failed to expire proposal:", error instanceof Error ? error.message : "unknown failure"); }
      }
      this.#requests.delete(id);
    }, SKILL_CONSENT_TTL_MS);
    timer.unref();
    const entry = { request: { ...request }, artifact, workspaceIdentity, controller, consent,
      proposalId: "", binding, consentId, status: "pending" as const, timer, expiresAt, completion, complete, fail };
    this.#requests.set(id, entry);
    try {
      if (decision.kind === "trusted_revision" || workflowApproved) {
        return { request_id: id, status: "finished" as const, result: await this.approve({ request_id: id }, !workflowApproved, workflowApproved) };
      }
      entry.proposalId = this.dependencies.proposal(request.agentId, {
        request_id: id, skill_id: request.skillId, artifact_revision: artifact.revision,
        input_digest: binding.inputDigest, workspace: request.workspace, runtime_version: process.version,
        timeout_ms: manifest.timeoutMs, max_output_bytes: manifest.maxOutputBytes,
        expires_at: new Date(expiresAt).toISOString(), full_trust: true,
      });
      return { request_id: id, proposal_id: entry.proposalId, status: "pending" as const };
    } catch (error) {
      if (this.#requests.get(id)?.status === "pending") this.cancel(id, request.agentId);
      throw error;
    }
  }

  inspect(id: string, agentId?: string) {
    const entry = this.#entry(id, agentId);
    return {
      request_id: id, agent_id: entry.request.agentId, skill_id: entry.request.skillId,
      status: entry.status, expires_at: new Date(entry.expiresAt).toISOString(),
      input_json: entry.request.inputJson, workspace: entry.request.workspace,
      artifact_revision: entry.artifact.revision, runtime_version: entry.binding.runtimeVersion,
      timeout_ms: entry.binding.timeoutMs, max_output_bytes: entry.binding.maxOutputBytes,
      files: entry.artifact.files.map((file) => ({
        ...file, base64: entry.artifact.readFile(file.path).toString("base64"),
      })), result: entry.result ?? null, ...(entry.error ? { error: entry.error } : {}),
    };
  }

  async approve(payload: unknown, trusted = false, workflowApproved = false): Promise<ExecutionResult> {
    if (!payload || typeof payload !== "object" || !("request_id" in payload) || typeof payload.request_id !== "string") {
      throw new Error("Invalid skill execution proposal");
    }
    const entry = this.#entry(payload.request_id);
    if (entry.status !== "pending") throw new Error("Skill execution has already been claimed");
    entry.status = "running";
    try {
      if (!trusted && !workflowApproved && !entry.proposalId) throw new Error("Skill execution has no human approval request");
      const target = { revision: entry.artifact.revision, agent_id: entry.request.agentId,
        workspace: entry.request.workspace, timeout_ms: entry.binding.timeoutMs, max_output_bytes: entry.binding.maxOutputBytes };
      const decision = this.dependencies.policy(target, this.dependencies.authorize(entry.request.agentId));
      if (decision.kind === "blocked") throw new Error(decision.reason);
      if (decision.kind === "require_workflow_consent" && !workflowApproved || trusted && decision.kind !== "trusted_revision") {
        throw new Error("Skill execution policy changed; fresh authorization required");
      }
      const current = SkillExecutionArtifact.capture(this.dependencies.directory(entry.request.skillId));
      if (current.revision !== entry.artifact.revision || identity(entry.request.workspace) !== entry.workspaceIdentity) {
        throw new Error("Skill source or workspace changed; request fresh approval");
      }
      entry.consent.decide(entry.consentId, "approve");
      const execution = runStagedSkill({
        artifact: entry.artifact, inputJson: entry.request.inputJson, binding: entry.binding,
        consent: entry.consent, proposalId: entry.consentId, signal: entry.controller.signal,
        owner: this.dependencies.owner(),
        policy: () => {
          const executeAllowed = this.dependencies.authorize(entry.request.agentId);
          const latest = this.dependencies.policy(target, executeAllowed);
          return { executeAllowed, safeMode: resolveSafetyMode() === "safe",
            blocked: latest.kind === "blocked" || latest.kind === "require_workflow_consent" && !workflowApproved
              || trusted && latest.kind !== "trusted_revision" };
        },
      });
      this.#active.add(execution);
      let result: ExecutionResult;
      try { result = await execution; }
      finally { this.#active.delete(execution); }
      entry.result = result; entry.status = "finished"; entry.complete(result);
      return result;
    } catch (error) {
      entry.status = "finished";
      entry.error = error instanceof Error ? error.message : "Skill execution failed";
      entry.fail(new Error(entry.error));
      throw error;
    } finally { entry.consent.close(); }
  }

  cancel(id: string, agentId?: string) {
    const entry = this.#entry(id, agentId);
    if (entry.status === "finished") throw new Error("Skill execution is already finished");
    entry.controller.abort(); entry.consent.close();
    entry.fail(new Error("Skill execution cancelled"));
    if (entry.status === "pending") {
      try { if (entry.proposalId) this.dependencies.expire(entry.proposalId); }
      finally { clearTimeout(entry.timer); this.#requests.delete(id); }
    }
  }

  async wait(id: string, signal: AbortSignal) {
    const entry = this.#entry(id);
    const abort = () => {
      entry.controller.abort();
      entry.fail(new Error("Skill execution cancelled"));
      if (entry.status === "pending" && this.#requests.has(id)) this.cancel(id);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      return await entry.completion;
    } finally { signal.removeEventListener("abort", abort); }
  }

  async close() {
    this.#closed = true;
    for (const entry of this.#requests.values()) {
      clearTimeout(entry.timer);
      if (entry.status !== "finished") {
        entry.controller.abort(); entry.consent.close();
        entry.fail(new Error("Skill execution service shut down"));
        if (entry.status === "pending" && entry.proposalId) {
          try { this.dependencies.expire(entry.proposalId); }
          catch (error) { console.error("[skill-execution] shutdown proposal invalidation failed:", error); }
        }
      }
    }
    const results = await Promise.allSettled(this.#active);
    for (const result of results) {
      if (result.status === "rejected" || !result.value.cleanupVerified) {
        console.error("[skill-execution] shutdown could not verify process cleanup");
      }
    }
    this.#requests.clear();
  }
  #entry(id: string, agentId?: string) {
    const entry = this.#requests.get(id);
    if (!entry || Date.now() >= entry.expiresAt) throw new Error("Skill execution expired or belongs to a previous app instance; request fresh approval");
    if (agentId !== undefined && entry.request.agentId !== agentId) throw new Error("Skill execution belongs to another agent");
    return entry;
  }
}

const KEY = Symbol.for("@jarela/skill-execution-service");
type GlobalService = typeof globalThis & { [KEY]?: SkillExecutionService };
export function skillExecutionService() {
  const state = globalThis as GlobalService;
  return state[KEY] ??= new SkillExecutionService({
    directory(id) {
      const resolved = resolveSkill(id);
      if (!resolved?.directory) throw new Error("Skill has no executable bundle");
      return resolved.directory;
    },
    authorize: executionAllowed,
    policy(target, allowed) {
      const availability = getSkillProcessOwnerAvailability();
      if (!availability.available) return { kind: "blocked", reason: availability.reason };
      return resolveSkillExecutionConsentRequirement(target, allowed);
    },
    owner: createSkillProcessOwner,
    proposal(agentId, payload) {
      return createPendingAction({ agent_id: agentId, kind: "execute_skill", payload,
        reason: "Run the exact reviewed skill code with full host permissions (not sandboxed)" }).id;
    },
    expire(id) {
      if (getPendingAction(id)?.status === "pending") {
        setActionStatus(id, "failed", { error: "Execution request cancelled or expired; request fresh approval" });
      }

    },
  });
}

export async function shutdownSkillExecutions() {
  await (globalThis as GlobalService)[KEY]?.close();
}
