import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { SkillRunStaging } from "@/lib/stores/skill-run-staging";
import { SkillExecutionArtifact } from "./execution-artifact";
import { SkillRunConsent, skillInvocationDigest, type SkillConsentBinding } from "./execution-consent";
import { SkillExecutionOutput, SkillExecutionOutputError } from "./execution-output";
import { validateSkillInvocation, type SkillJsonValue } from "./execution-protocol";

export const SKILL_PRODUCTION_EXECUTION_AVAILABLE = false;
const CLEANUP_MS = 1000;

export interface OwnedSkillProcess {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  completion: Promise<{ exitCode: number | null; signal: string | null }>;
  // Must terminate/reap descendants even after the immediate process exits.
  stopAndVerifyTree(): Promise<boolean>;
}

export interface SkillProcessOwner {
  launch(input: {
    executable: string; args: readonly string[]; cwd: string;
    stdin: string; env: Readonly<Record<string, string>>;
  }): OwnedSkillProcess;
}

type RunnerResult = {
  revision: string; runtimeVersion: string; elapsedMs: number;
  cleanupVerified: boolean;
} & (
  | { status: "succeeded"; output: SkillJsonValue; diagnostics: string; exitCode: 0 }
  | { status: "failed" | "cancelled" | "timed_out"; error: string; exitCode: number | null }
);

function workspaceIdentity(path: string) {
  if (!isAbsolute(path) || path !== resolve(path) || realpathSync(path) !== path) {
    throw new Error("Workspace must be a canonical absolute path");
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace must be an unlinked directory");
  return { dev: stat.dev, ino: stat.ino };
}

async function boundedCleanup(work: () => Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verified = await Promise.race([
      work(),
      new Promise<false>((done) => { timer = setTimeout(() => done(false), CLEANUP_MS); }),
    ]);
    return verified === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Internal orchestration only. No production process owner, route or tool exists.
export async function runStagedSkill(input: {
  artifact: SkillExecutionArtifact; inputJson: string; binding: SkillConsentBinding;
  consent: SkillRunConsent; proposalId: string; signal: AbortSignal;
  policy: () => { executeAllowed: boolean; safeMode: boolean; blocked: boolean };
  owner: SkillProcessOwner;
}): Promise<RunnerResult> {
  const start = performance.now();
  const revision = input.artifact.revision;
  const manifest = input.artifact.getManifest();
  const capture = new SkillExecutionOutput(manifest);
  let staging: SkillRunStaging | undefined;
  let child: OwnedSkillProcess | undefined;
  let cleanupVerified = true;
  let exitCode: number | null = null;
  let error = "execution_failed";
  let status: "failed" | "cancelled" | "timed_out" = "failed";
  let checked: ReturnType<SkillExecutionOutput["finish"]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (input.signal.aborted) { status = "cancelled"; throw new Error("Run aborted"); }
    validateSkillInvocation(manifest, input.inputJson);
    if (input.binding.artifactRevision !== revision || input.binding.inputDigest !== skillInvocationDigest(input.inputJson)
      || input.binding.runtimeVersion !== process.version || input.binding.timeoutMs !== manifest.timeoutMs
      || input.binding.maxOutputBytes !== manifest.maxOutputBytes) {
      error = "binding_changed"; throw new Error("Binding changed");
    }
    const workspace = workspaceIdentity(input.binding.workspace);
    const before = input.policy();
    if (before.blocked || !before.executeAllowed || before.safeMode) {
      error = "policy_denied"; throw new Error("Policy denied");
    }
    staging = SkillRunStaging.create(input.artifact);
    staging.verify();
    const currentWorkspace = workspaceIdentity(input.binding.workspace);
    if (workspace.dev !== currentWorkspace.dev || workspace.ino !== currentWorkspace.ino) {
      error = "workspace_changed"; throw new Error("Workspace changed");
    }
    const policy = input.policy();
    if (policy.blocked) { error = "policy_denied"; throw new Error("Policy denied"); }
    if (input.signal.aborted) { status = "cancelled"; throw new Error("Run aborted"); }
    input.consent.consume(input.proposalId, input.binding, policy);
    // A throwing launch may have started a process without returning its owner.
    // Retain staging and fail cleanup unless ownership is positively established.
    cleanupVerified = false;
    child = input.owner.launch({
      executable: process.execPath, args: [join(staging.directory, manifest.entrypoint)],
      cwd: input.binding.workspace, stdin: input.inputJson, env: {},
    });
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => { status = "cancelled"; error = "cancelled"; reject(new Error("Run aborted")); };
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();
      timer = setTimeout(() => {
        status = "timed_out"; error = "timeout"; reject(new Error("Run timed out"));
      }, manifest.timeoutMs);
    });
    async function read(stream: AsyncIterable<Uint8Array>, write: (bytes: Uint8Array) => void) {
      for await (const bytes of stream) write(bytes);
    }
    const [exit] = await Promise.race([
      Promise.all([
        child.completion,
        read(child.stdout, (bytes) => capture.writeStdout(bytes)),
        read(child.stderr, (bytes) => capture.writeStderr(bytes)),
      ]),
      interrupted,
    ]);
    exitCode = exit.exitCode;
    if (exit.exitCode !== 0 || exit.signal !== null) { error = "nonzero_exit"; throw new Error("Process failed"); }
    checked = capture.finish();
  } catch (failure) {
    if (failure instanceof SkillExecutionOutputError) error = failure.code;
    if (input.signal.aborted) { status = "cancelled"; error = "cancelled"; }
  } finally {
    clearTimeout(timer);
    if (onAbort) input.signal.removeEventListener("abort", onAbort);
    capture.dispose();
    if (child) cleanupVerified = await boundedCleanup(() => child!.stopAndVerifyTree());
    // Keep staging if descendants may still be reading it. Never claim cleanup.
    if (staging && cleanupVerified) {
      try { staging.dispose(); }
      catch { cleanupVerified = false; error = "staging_cleanup_failed"; }
    }
  }
  const common = { revision, runtimeVersion: process.version, elapsedMs: performance.now() - start, cleanupVerified };
  if (!cleanupVerified) return { ...common, status: "failed", error: "cleanup_unverified", exitCode };
  if (input.signal.aborted) return { ...common, status: "cancelled", error: "cancelled", exitCode };
  if (checked && status === "failed") {
    return { ...common, status: "succeeded", output: checked.output, diagnostics: checked.diagnostics, exitCode: 0 };
  }
  return { ...common, status, error, exitCode };
}
