import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { Script } from "node:vm";
import { getDataDir } from "@/lib/db/data-dir";
import { getConfig } from "@/lib/env/config";
import { listSkillRepos } from "@/lib/stores/skill-repos";
import { SkillRunStaging } from "@/lib/stores/skill-run-staging";
import { readSkillFileBytes } from "@/lib/skills/bundle-files";
import { SkillRunConsent, skillInvocationDigest, SKILL_CONSENT_TTL_MS } from "@/lib/skills/execution-consent";
import { runStagedSkill } from "@/lib/skills/execution-runner";
import { createSkillProcessOwner } from "@/lib/skills/process-owner";
import { resolveSkillExecutionConsentRequirement } from "@/lib/skills/execution-policy-server";
import { getAgentConfig, getAgentTools, compareAndSetAgentTools } from "@/lib/stores/agent-configs";
import { createPendingAction, getPendingAction, setActionStatus } from "@/lib/stores/pending-actions";
import { isDropinDisabled, setDropinDisabled } from "@/lib/stores/disabled-dropin-tools";
import { getToolConfig, setToolConfig } from "@/lib/stores/tool-config";
import { disabledCategories } from "@/lib/stores/builtin-tools";
import { isMasterKeyLocked } from "@/lib/crypto/master-key";
import { isScreenLocked } from "@/lib/security/screen-lock";
import { resolveSafetyMode } from "@/lib/tools/security/safety";
import { registeredNames } from "@/lib/tools/runtime/registry";
import { getOrCreateAgentThread } from "@/lib/stores/threads";
import { containsSensitive, scaffoldExtension, ScaffoldExtensionInput } from "./authoring";
import { extensionArtifact } from "./extension-artifact";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const SESSION_TTL = 30 * 60 * 1000;
export const ExtensionStage = z.enum(["stage", "test", "install", "configure", "enable", "verify", "disable", "remove", "restore", "discard"]);
type Stage = z.infer<typeof ExtensionStage>;
export const ExtensionCreateInput = ScaffoldExtensionInput.extend({
  source: z.string().min(1).max(16384)
    .refine((value) => value.isWellFormed() && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 16384)
    .describe("Exact CommonJS source; at most 16 KiB UTF-8").optional(),
});
export const ExtensionStageInput = z.strictObject({
  id: z.uuid(), stage: ExtensionStage,
  fixture_origin: z.string().max(200).optional(),
});
function identity(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error("Use a canonical absolute unlinked directory");
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Directory identity is not safe");
  return `${stat.dev}:${stat.ino}`;
}
function canonicalFuture(path: string): string {
  const full = resolve(path);
  let parent = full;
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) throw new Error("Cannot establish directory identity");
    parent = next;
  }
  identity(parent);
  return full;
}
function anchor(path: string) {
  let parent = resolve(path);
  while (!existsSync(parent)) parent = dirname(parent);
  return { path: parent, identity: identity(parent) };
}
function overlaps(a: string, b: string) {
  const inside = (parent: string, child: string) => { const path = relative(parent, child); return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
  return inside(a, b) || inside(b, a);
}
function origin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Only an explicit loopback synthetic fixture origin is supported");
  }
  return url.origin;
}
type Session = {
  id: string; agentId: string; workspace: string; workspaceIdentity: string; toolsDir: string; stagingRoot: string;
  name: string; artifact: ReturnType<typeof extensionArtifact>; staging?: SkillRunStaging;
  tested: boolean; installedHash: string | null; previous: Buffer | null;
  configured?: string; verified: boolean; expiresAt: number; active?: string;
};
type Operation = {
  id: string; session: Session; stage: Stage; revision: string; proposalId: string; expiresAt: number;
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  controller: AbortController; preview: Record<string, unknown>; origin?: string;
  expectedHash: string | null; toolsIdentity?: string; toolsAnchor: ReturnType<typeof anchor>; agentTools: string;
  configuration: ReturnType<typeof getToolConfig>; disabled: boolean;
  stagingAnchor: ReturnType<typeof anchor>;
  output?: unknown; error?: string; work?: Promise<unknown>;
};
export interface ExtensionDependencies {
  toolsDir(): string;
  autoloadDirs(): string[];
  allowed(agentId: string): boolean;
  test(session: { artifact: Session["artifact"]; agentId: string; workspace: string; runId: string }, signal: AbortSignal): Promise<{ passed: boolean; evidence: unknown }>;
  verify(session: { agentId: string; workspace: string; name: string }, signal: AbortSignal): Promise<unknown>;
}
function installedBytes(directory: string, name: string) {
  const path = join(directory, `${name}.cjs`);
  // lstat catches dangling links; existsSync alone would treat them as absence.
  try { lstatSync(path); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null; throw error; }
  return readSkillFileBytes(directory, `${name}.cjs`, 16384);
}

export class ExtensionService {
  readonly #sessions = new Map<string, Session>();
  readonly #operations = new Map<string, Operation>();
  #closed = false;
  constructor(readonly dependencies: ExtensionDependencies) {}

  create(agentId: string, workspace: string, input: unknown) {
    this.#sweep();
    this.#allowed(agentId);
    if (this.#sessions.size >= 8) throw new Error("Authoring capacity reached; cancel or wait for expiry");
    const parsed = ExtensionCreateInput.parse(input);
    const { source, ...scope } = parsed;
    if (source !== undefined && containsSensitive(source)) throw new Error("Remove sensitive source content before authoring");
    if (source !== undefined) {
      try { new Script(source, { filename: `${parsed.name}.cjs` }); }
      catch { throw new Error("CommonJS source failed inert syntax validation"); }
    }
    if (registeredNames().has(parsed.name)) throw new Error("Extension name collides with a registered built-in");
    const scaffold = scaffoldExtension(scope);
    if (!scaffold.ok) throw new Error("Authoring discovery/scope rejected; reuse existing capability or remove sensitive input");
    const toolsDir = resolve(this.dependencies.toolsDir());
    const workspaceIdentity = identity(workspace);
    this.#checkIsolation();
    const previous = existsSync(toolsDir) ? installedBytes(toolsDir, parsed.name) : null;
    const session: Session = { id: randomUUID(), agentId, workspace, workspaceIdentity, toolsDir, stagingRoot: resolve(join(getDataDir(), "skill-runs")),
      name: parsed.name, artifact: extensionArtifact(parsed.name, source), tested: false, verified: false,
      installedHash: previous ? hash(previous) : null, previous, expiresAt: Date.now() + SESSION_TTL };
    this.#sessions.set(session.id, session);
    return this.inspect(session.id, agentId);
  }

  inspect(id: string, agentId?: string) {
    const session = this.#session(id, agentId);
    return { id, agentId: session.agentId, name: session.name, revision: session.artifact.revision,
      staging_directory: session.staging?.directory ?? null, tested: session.tested, verified: session.verified,
      installed_revision: session.installedHash, previous_revision: session.previous ? hash(session.previous) : null,
      active_operation: session.active ?? null, expires_at: new Date(session.expiresAt).toISOString(),
      execution_authorized: false, installation_authorized: false, publication_authorized: false };
  }

  request(agentId: string, input: unknown) {
    const parsed = ExtensionStageInput.parse(input);
    const session = this.#session(parsed.id, agentId);
    this.#allowed(agentId);
    this.#checkSession(session);
    if (session.active) this.#operation(session.active, agentId);
    if (session.active) throw new Error("An authoring operation is pending or still executing");
    if (this.#operations.size >= 128) throw new Error("Authoring operation capacity reached");
    const stage = parsed.stage;
    if (stage !== "configure" && parsed.fixture_origin !== undefined) throw new Error("Fixture origin is only valid for configuration");
    if (stage === "stage" && session.staging) throw new Error("Artifact is already staged");
    if (stage !== "stage" && !session.staging) throw new Error("Approve inert staging first");
    if (session.staging) session.staging.verify();
    if (stage === "install" && !session.tested) throw new Error("Observed passing tests are required before installation");
    if (stage === "restore" && !session.previous) throw new Error("No prior reviewed source is retained");
    const current = installedBytes(session.toolsDir, session.name);
    const expectedHash = current ? hash(current) : null;
    if (stage === "install" && expectedHash !== session.installedHash) throw new Error("Installed baseline changed since authoring began");
    if (["configure", "enable", "verify"].includes(stage) && expectedHash !== session.installedHash) throw new Error("Installed artifact changed");
    if (["configure", "enable", "verify", "disable", "remove"].includes(stage) && current === null) throw new Error("Extension is not installed");
    if (stage === "enable" && !session.tested) throw new Error("Retest restored/changed bytes before enablement");
    if (["enable", "verify"].includes(stage) && expectedHash !== hash(session.artifact.readFile(`${session.name}.cjs`))) {
      throw new Error("Install the exact tested candidate before enablement or verification");
    }
    if (stage === "verify" && (!session.configured || isDropinDisabled(session.name) || !getAgentTools(getAgentConfig(agentId)).includes(session.name))) {
      throw new Error("Configure and separately enable this exact tool first");
    }
    const agent = getAgentConfig(agentId);
    if (!agent) throw new Error("Authoring agent not found");
    const id = randomUUID();
    const revision = session.artifact.revision;
    const preview: Record<string, unknown> = {
      operation_id: id, operation_type: "extension", stage, session_id: session.id, revision,
      agent_id: agentId, workspace: session.workspace, destination: join(session.toolsDir, `${session.name}.cjs`),
      staging_parent: session.stagingRoot, staged_directory: session.staging?.directory ?? null,
      previous_installed_sha256: expectedHash, previous_agent_tools: getAgentTools(agent),
      previous_fixture_origin: getToolConfig(session.name, "base_url"), previously_disabled: isDropinDisabled(session.name),
      previous_source: stage === "install" || stage === "remove" ? current?.toString("utf8") ?? null : undefined,
      privileges: stage === "test" || stage === "verify" ? "Full-trust code execution: host files and network, NOT sandboxed" :
        stage === "install" ? "Exact source copied into full-trust auto-import directory; initially disabled for invocation" :
          stage === "restore" ? "Disable and select retained prior bytes as a candidate; new staging, tests and installation required" :
          stage === "enable" ? "Enable globally and add only this tool to this agent" :
            stage === "remove" ? "Disable globally, remove exact source and revoke this selected agent's tool grant" :
              stage === "disable" ? "Disable globally; does not kill in-flight imports/calls" : stage,
      fixture_origin: stage === "configure" ? origin(parsed.fixture_origin ?? "") : undefined,
      runtime: process.version, timeout_ms: stage === "test" ? 10000 : undefined,
      files: session.artifact.files.map((file) => ({ ...file, content: session.artifact.readFile(file.path).toString("utf8") })),
      prior_source: stage === "restore" ? session.previous?.toString("utf8") : undefined,
      tests: { observed_pass: session.tested }, automatic_rollback: false, publication_authorized: false,
    };
    const op: Operation = { id, session, stage, revision, proposalId: "", preview, expectedHash,
      origin: stage === "configure" ? origin(parsed.fixture_origin ?? "") : undefined,
      configuration: getToolConfig(session.name, "base_url"), disabled: isDropinDisabled(session.name),
      stagingAnchor: anchor(session.stagingRoot),
      agentTools: agent.tools, toolsIdentity: existsSync(session.toolsDir) ? identity(session.toolsDir) : undefined, toolsAnchor: anchor(session.toolsDir),
      state: "pending", controller: new AbortController(), expiresAt: Date.now() + SKILL_CONSENT_TTL_MS };
    op.proposalId = createPendingAction({ agent_id: agentId, kind: "authoring_operation",
      payload: { operation_id: id, operation_type: "extension", stage, revision },
      reason: `Review exact extension ${stage}; no approval transfers to another stage` }).id;
    session.active = id;
    this.#operations.set(id, op);
    return { operation_id: id, proposal_id: op.proposalId, status: "pending", session_id: session.id };
  }

  inspectOperation(id: string, agentId?: string) {
    const op = this.#operation(id, agentId);
    return { ...op.preview, proposal_id: op.proposalId, status: op.state, expires_at: new Date(op.expiresAt).toISOString(), output: op.output, error: op.error };
  }

  async approve(id: string, agentId?: string) {
    const op = this.#operation(id, agentId);
    if (op.state !== "pending") throw new Error(op.error ?? "Authoring operation is not pending");
    this.#session(op.session.id);
    op.state = "running";
    const work = this.#apply(op);
    op.work = work;
    try {
      op.output = await work;
      if (op.controller.signal.aborted) { op.state = "unknown"; throw new Error("Operation cancelled; inspect actual effects before retrying"); }
      op.state = "succeeded";
      return this.inspectOperation(id);
    } catch (error) {
      op.state = op.controller.signal.aborted ? "unknown" : "failed";
      op.error = error instanceof Error ? error.message : "Extension operation failed";
      throw error;
    } finally { op.session.active = undefined; }
  }

  cancel(id: string, agentId?: string) {
    const op = this.#operation(id, agentId);
    if (op.state !== "pending" && op.state !== "running") throw new Error("Operation already finished");
    op.controller.abort();
    if (op.state === "pending") {
      op.state = "cancelled"; op.session.active = undefined;
      if (getPendingAction(op.proposalId)?.status === "pending") setActionStatus(op.proposalId, "denied", { error: "Authoring operation cancelled" });
    } else op.state = "unknown";
    return { operation_id: id, status: op.state, rollback: false };
  }

  async close() {
    this.#closed = true;
    for (const op of this.#operations.values()) {
      if (op.state === "pending" || op.state === "running") op.controller.abort();
    }
    try {
      for (const op of this.#operations.values()) {
        this.#operation(op.id);
        if (op.state === "pending" || op.state === "running") this.cancel(op.id);
      }
    } finally {
      await Promise.allSettled([...this.#operations.values()].flatMap((op) => op.work ? [op.work] : []));
    }
  }

  async #apply(op: Operation): Promise<unknown> {
    const session = op.session;
    this.#allowed(session.agentId);
    this.#checkSession(session);
    if (Date.now() >= op.expiresAt || op.controller.signal.aborted) throw new Error("Operation expired or cancelled");
    if (session.artifact.revision !== op.revision) throw new Error("Reviewed source changed");
    if (session.staging) session.staging.verify();
    const current = installedBytes(session.toolsDir, session.name);
    if ((current ? hash(current) : null) !== op.expectedHash) throw new Error("Installed source changed after review");
    if (identity(op.toolsAnchor.path) !== op.toolsAnchor.identity || (op.toolsIdentity
      ? identity(session.toolsDir) !== op.toolsIdentity : existsSync(session.toolsDir))) throw new Error("Installation directory changed after review");
    if (identity(op.stagingAnchor.path) !== op.stagingAnchor.identity) throw new Error("Staging directory changed after review");
    if (getAgentConfig(session.agentId)?.tools !== op.agentTools) throw new Error("Agent permissions changed after review");
    if (getToolConfig(session.name, "base_url") !== op.configuration || isDropinDisabled(session.name) !== op.disabled) throw new Error("Extension configuration or enabled state changed after review");
    switch (op.stage) {
      case "stage":
        this.#checkIsolation();
        session.staging = SkillRunStaging.create(session.artifact);
        session.staging.retainSource();
        return { staging_directory: session.staging.directory, revision: session.artifact.revision, inert: true };
      case "discard": {
        const directory = session.staging!.directory;
        session.staging!.dispose();
        session.staging = undefined; session.tested = false;
        return { discarded_directory: directory, installed_tool_unchanged: true };
      }
      case "test": {
        session.tested = false;
        const result = await this.dependencies.test({ ...session, runId: op.id }, op.controller.signal);
        if (!result.passed || op.controller.signal.aborted) throw new Error("Fixture tests failed or were cancelled");
        session.staging!.verify();
        session.tested = true;
        return result.evidence;
      }
      case "restore": {
        setDropinDisabled(session.name, true);
        session.artifact = extensionArtifact(session.name, session.previous!.toString("utf8"));
        session.staging = undefined;
        session.tested = false; session.verified = false;
        return { restored_candidate: session.artifact.revision, installed: false, disabled: true, required: ["stage", "test", "install", "enable", "verify"] };
      }
      case "install": {
        if (!session.tested) throw new Error("Passing test evidence missing");
        const source = session.artifact.readFile(`${session.name}.cjs`);
        // Only the exact configured destination reviewed in this installation operation.
        mkdirSync(session.toolsDir, { recursive: true, mode: 0o700 });
        identity(session.toolsDir);
        setDropinDisabled(session.name, true);
        const temporary = join(session.toolsDir, `.${session.name}-${randomUUID()}.pending`);
        writeFileSync(temporary, source, { flag: "wx", mode: 0o600 });
        try {
          if ((installedBytes(session.toolsDir, session.name) ? hash(installedBytes(session.toolsDir, session.name)!) : null) !== op.expectedHash) throw new Error("Installation source changed");
          renameSync(temporary, join(session.toolsDir, `${session.name}.cjs`));
        } finally { if (existsSync(temporary)) unlinkSync(temporary); }
        session.installedHash = hash(source);
        if (hash(installedBytes(session.toolsDir, session.name)!) !== session.installedHash) throw new Error("Installed source readback does not match reviewed bytes");
        session.verified = false;
        const { _resetExternalCache } = await import("@/lib/tools/runtime/external");
        _resetExternalCache();
        return { installed_sha256: session.installedHash, disabled: true, approval_required: "configure/enable/verify separately" };
      }
      case "configure":
        setToolConfig(session.name, "base_url", op.origin!);
        session.configured = op.origin;
        session.verified = false;
        return { configured: getToolConfig(session.name, "base_url") === op.origin, origin: op.origin };
      case "enable": {
        compareAndSetAgentTools(session.agentId, op.agentTools, [...getAgentTools(getAgentConfig(session.agentId)), session.name]);
        setDropinDisabled(session.name, false);
        return { enabled: true, agent_id: session.agentId, verified: false };
      }
      case "verify": {
        if (isDropinDisabled(session.name) || !getAgentTools(getAgentConfig(session.agentId)).includes(session.name)) throw new Error("Installed capability was disabled after review");
        if (getToolConfig(session.name, "base_url") !== session.configured) throw new Error("Configuration changed after review");
        const output = await this.dependencies.verify(session, op.controller.signal);
        if (op.controller.signal.aborted || JSON.stringify(output) !== JSON.stringify({ value: "synthetic" })) throw new Error("Actual installed capability verification failed");
        if (hash(installedBytes(session.toolsDir, session.name)!) !== session.installedHash) throw new Error("Installed bytes changed during verification");
        session.verified = true;
        return { observed: output, verified: true, installed_sha256: session.installedHash };
      }
      case "disable":
        setDropinDisabled(session.name, true);
        session.verified = false;
        return { disabled: isDropinDisabled(session.name), in_flight_execution_stopped: false };
      case "remove": {
        setDropinDisabled(session.name, true);
        unlinkSync(join(session.toolsDir, `${session.name}.cjs`));
        compareAndSetAgentTools(session.agentId, op.agentTools, getAgentTools(getAgentConfig(session.agentId)).filter((name) => name !== session.name));
        session.installedHash = null; session.verified = false;
        const { _resetExternalCache } = await import("@/lib/tools/runtime/external");
        _resetExternalCache();
        return { removed: installedBytes(session.toolsDir, session.name) === null, retained_staging: session.staging!.directory };
      }
    }
  }

  #checkIsolation() {
    const staging = canonicalFuture(join(getDataDir(), "skill-runs"));
    if (this.dependencies.autoloadDirs().some((path) => overlaps(staging, canonicalFuture(path)))) throw new Error("Staging overlaps a configured autoload directory");
  }
  #checkSession(session: Session) {
    if (identity(session.workspace) !== session.workspaceIdentity || resolve(this.dependencies.toolsDir()) !== session.toolsDir
      || resolve(join(getDataDir(), "skill-runs")) !== session.stagingRoot) throw new Error("Workspace or configured destination changed");
    this.#checkIsolation();
  }
  #allowed(agentId: string) {
    if (this.#closed || !this.dependencies.allowed(agentId)) throw new Error("Extension operation is not currently permitted");
  }
  #session(id: string, agentId?: string) {
    const session = this.#sessions.get(id);
    if (!session || Date.now() >= session.expiresAt) throw new Error("Authoring session expired or belongs to a previous app instance");
    if (agentId !== undefined && session.agentId !== agentId) throw new Error("Authoring belongs to another agent");
    return session;
  }
  #operation(id: string, agentId?: string) {
    const op = this.#operations.get(id);
    if (!op) throw new Error("Authoring operation expired or belongs to a previous app instance");
    if (agentId !== undefined && op.session.agentId !== agentId) throw new Error("Authoring belongs to another agent");
    if (Date.now() >= op.expiresAt && op.state === "pending") {
      op.state = "failed"; op.error = "Review expired; request a fresh stage";
      op.controller.abort(); op.session.active = undefined;
      if (getPendingAction(op.proposalId)?.status === "pending") setActionStatus(op.proposalId, "failed", { error: op.error });
    }
    return op;
  }
  #sweep() {
    for (const session of this.#sessions.values()) {
      if (Date.now() < session.expiresAt || session.active && this.#operations.get(session.active)?.state !== "pending") continue;
      if (session.active && this.#operation(session.active).state === "pending") this.cancel(session.active);
      this.#sessions.delete(session.id);
      for (const op of this.#operations.values()) if (op.session === session) this.#operations.delete(op.id);
    }
  }
}

const KEY = Symbol.for("@jarela/extension-authoring-service");
type GlobalService = typeof globalThis & { [KEY]?: ExtensionService };
export function extensionService() {
  return (globalThis as GlobalService)[KEY] ??= new ExtensionService({
    toolsDir: () => getConfig().toolsDir,
    autoloadDirs: () => [getConfig().toolsDir, join(getDataDir(), "providers"), ...listSkillRepos().map((repo) => repo.path)],
    allowed(agentId) {
      return !isMasterKeyLocked() && !isScreenLocked() && resolveSafetyMode() !== "safe"
        && !disabledCategories().has("Config") && getAgentTools(getAgentConfig(agentId)).includes("request_extension_stage");
    },
    async test(session, signal) {
      const target = { agent_id: session.agentId, workspace: session.workspace, revision: session.artifact.revision, timeout_ms: 10000, max_output_bytes: 1024 };
      const policy = () => {
        const allowed = getAgentTools(getAgentConfig(session.agentId)).includes("request_extension_stage")
          && !disabledCategories().has("Config") && !isMasterKeyLocked() && !isScreenLocked();
        const decision = resolveSkillExecutionConsentRequirement(target, allowed);
        return { executeAllowed: allowed, safeMode: resolveSafetyMode() === "safe", blocked: decision.kind === "blocked" || decision.kind === "require_workflow_consent" };
      };
      const consent = new SkillRunConsent({ agentId: session.agentId, runId: session.runId, workspace: session.workspace }, signal);
      const binding = { agentId: session.agentId, runId: session.runId, workspace: session.workspace, artifactRevision: session.artifact.revision,
        inputDigest: skillInvocationDigest("{}"), runtimeVersion: process.version, timeoutMs: 10000, maxOutputBytes: 1024 };
      const proposal = consent.propose(binding);
      consent.decide(proposal.id, "approve");
      try {
        const result = await runStagedSkill({ artifact: session.artifact, inputJson: "{}", binding, consent, proposalId: proposal.id, signal, policy, owner: createSkillProcessOwner() });
        return { passed: result.status === "succeeded" && result.cleanupVerified, evidence: result };
      } finally { consent.close(); }
    },
    async verify(session, signal) {
      const { getAllToolCatalogAsync, applyAgentPermissionsToCatalog, executeTool } = await import("@/lib/tools");
      const agent = getAgentConfig(session.agentId);
      if (!agent) throw new Error("Agent no longer exists");
      const permitted = applyAgentPermissionsToCatalog(await getAllToolCatalogAsync(), agent).find((tool) => tool.name === session.name);
      if (permitted?.permission !== "enabled") throw new Error("Installed capability is not permitted");
      return executeTool(session.name, { value: "synthetic" }, { signal, await_tool_settlement: true,
        thread_id: getOrCreateAgentThread(session.agentId).thread_id, workspace: { root: session.workspace, scoped: true } });
    },
  });
}
