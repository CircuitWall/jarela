import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { getDataDir } from "@/lib/db/data-dir";
import { getAgentConfig, getAgentTools } from "@/lib/stores/agent-configs";
import { createPendingAction, getPendingAction, setActionStatus } from "@/lib/stores/pending-actions";
import { SkillExecutionArtifact } from "@/lib/skills/execution-artifact";
import { SkillRunConsent, skillInvocationDigest } from "@/lib/skills/execution-consent";
import { runStagedSkill } from "@/lib/skills/execution-runner";
import type { SkillProcessOwner } from "@/lib/skills/execution-runner";
import { createSkillProcessOwner, getSkillProcessOwnerAvailability } from "@/lib/skills/process-owner";
import { resolveSkillExecutionConsentRequirement } from "@/lib/skills/execution-policy-server";
import { getConfig } from "@/lib/env/config";
import { resolvePackageAuth } from "@/lib/tools/runtime/auth-registry";
import { optionalFunction } from "@/lib/tools/packages/optional-package";
import { disabledCategories } from "@/lib/stores/builtin-tools";
import { isMasterKeyLocked } from "@/lib/crypto/master-key";
import { isScreenLocked } from "@/lib/security/screen-lock";
import { resolveSafetyMode } from "@/lib/tools/security/safety";
import { portableSkillPath, readSkillFileBytes } from "@/lib/skills/bundle-files";
import { listSkillRepos } from "@/lib/stores/skill-repos";
import { SECRET_PATTERNS } from "../../scripts/lib/secret-patterns.mjs";
import { ContributionBundleInput, prepareContributionBundle } from "./authoring";

const execFileAsync = promisify(execFile);
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_OPERATIONS = 16;
const MAX_TEST_FILE_BYTES = 128 * 1024;
const MAX_TEST_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 20_000;
const TEST_COMMAND = "node node_modules/vitest/vitest.mjs run --reporter=json --outputFile <owned-staging>/observed-results.json --passWithNoTests=false";
const HASH = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const commitPattern = /^(feat|fix|docs|test|chore|refactor)(\([a-z0-9-]+\))?: [^\r\n]{1,60}$/;
const sourcePathPattern = /(?:^|\/)(?:\.git|node_modules|\.env(?:\.[^/]*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|memory|chats?|transcripts?|logs?)(?:\/|$)|\.(?:pem|key|sqlite|db|log)$/i;

const contributionFile = z.strictObject({
  path: portableSkillPath,
  content: z.string().max(16_384).nullable().refine((value) => value === null
    || value.isWellFormed() && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 16_384,
  "Expected at most 16 KiB of well-formed UTF-8 text"),
});
export const ContributionCreateInput = ContributionBundleInput.omit({
  worktree: true,
  tests: true,
  files: true,
}).extend({
  commit_message: z.string().min(1).max(72).regex(commitPattern),
  files: z.array(contributionFile).min(1).max(32),
  test_files: z.array(portableSkillPath).min(1).max(16)
    .refine((paths) => new Set(paths.map((path) => path.toLowerCase())).size === paths.length, "Test paths must be unique")
    .refine((paths) => paths.every((path) => /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(path)), "Test paths must be literal portable source paths, not options or glob patterns")
    .refine((paths) => paths.every((path) => /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i.test(path)), "Select explicit Vitest test files only"),
}).strict().superRefine((input, ctx) => {
  const paths = input.files.map((file) => file.path.toLowerCase());
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: "custom", path: ["files"], message: "Selected paths must be unique" });
});
export const ContributionOperationInput = z.strictObject({ operation_id: z.uuid() });

type CreateInput = z.infer<typeof ContributionCreateInput>;
type ContributionStage = "tests" | "commit" | "push" | "draft_pr";
type OperationState = "pending" | "running" | "finished" | "unknown";
type RepoFile = { path: string; before: string | null; after: string | null };
type TestSource = { path: string; content: string; sha256: string };
type HookSource = { name: string; path: string; content: string; sha256: string; executable: boolean };
type Remote =
  | { kind: "github"; owner: string; repo: string; display: string }
  | { kind: "local"; path: string; display: string }
  | { kind: "unsupported"; display: string };

type Operation = {
  id: string;
  agentId: string;
  workspace: string;
  workspaceIdentity: string;
  sourceBranch: string;
  input: CreateInput;
  files: RepoFile[];
  tests: TestSource[];
  worktree: string;
  worktreeIdentity?: string;
  testArtifact?: SkillExecutionArtifact;
  vitestEntrypoint: string;
  vitestSha256: string;
  testHooks: HookSource[];
  commitHooks?: HookSource[];
  pushHooks?: HookSource[];
  bundle?: Record<string, unknown> & { revision: string; diff: string };
  bundleRevision?: string;
  revision: string;
  stage: ContributionStage;
  proposalId: string;
  state: OperationState;
  expiresAt: number;
  controller: AbortController;
  preview: Record<string, unknown>;
  output?: unknown;
  error?: string;
  outcome?: "succeeded" | "failed" | "cancelled";
  work?: Promise<unknown>;
  commit?: string;
  remote?: Remote;
  testEvidence?: { command: string; evidence: string };
  hostWork?: Promise<unknown>;
  gitEvidence?: Array<{ command: string; status: string; cleanup_verified: boolean; output_sha256?: string }>;
};

type GithubAuth = { token: string };
type GithubFetch = (auth: GithubAuth, path: string, init?: RequestInit) => Promise<unknown>;
const githubFetch = optionalFunction<GithubFetch>(
  "@circuitwall/github-langchain",
  "githubFetch",
  () => { throw new Error("GitHub integration is unavailable"); },
);

export interface ContributionDependencies {
  allowed(agentId: string): boolean;
  ownedProcessAvailable?(): boolean;
  allowGitUrlRewriteForTests?: boolean;
  processOwner?(): SkillProcessOwner;
  now?(): number;
  gitTimeoutMs?: number;
  githubAuth(): GithubAuth | { error: string };
  githubFetch(auth: GithubAuth, path: string, init?: RequestInit): Promise<unknown>;
}

function isErrno(error: unknown, code: string) {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function identity(path: string) {
  if (!isAbsolute(path) || path !== resolve(path) || realpathSync(path) !== path) {
    throw new Error("Workspace must be a canonical absolute path");
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace must be an unlinked directory");
  return `${stat.dev}:${stat.ino}`;
}

function inside(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...processEnvForTests() } as NodeJS.ProcessEnv;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "Never";
  return env;
}

const readGitConfig = [
  "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
  "-c", "credential.helper=", "-c", "core.askPass=",
  "-c", "diff.external=", "-c", "core.pager=cat",
];

async function git(root: string, args: string[], maxBuffer = 256 * 1024): Promise<Buffer> {
  const commands = ["status", "rev-parse", "branch", "for-each-ref", "ls-files", "ls-tree", "cat-file",
    "check-ignore", "config", "remote", "diff", "var", "worktree"];
  if (!commands.includes(args[0]) || args[0] === "branch" && args[1] !== "--list"
    || args[0] === "worktree" && args[1] !== "list"
    || args[0] === "config" && args[1] !== "--get"
    || args[0] === "remote" && args[1] !== "get-url") throw new Error("Unapproved executable Git operation is blocked");
  const safeArgs = args[0] === "diff" ? [args[0], "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
  try {
    let filterKeys: string[] = [];
    try {
      const filters = await execFileAsync("git", [
        ...readGitConfig, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$",
      ], { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8", env: cleanGitEnv() });
      filterKeys = filters.stdout.split("\0").filter(Boolean);
    } catch (error) {
      if (!isErrno(error, "1") && !(error !== null && typeof error === "object" && "code" in error && error.code === 1)) throw error;
    }
    if (filterKeys.length > 128 || filterKeys.some((key) => !/^filter\.[^\r\n\0]+\.(?:clean|smudge|process|required)$/i.test(key))) {
      throw new Error("Unsupported Git filter configuration");
    }
    const filterConfig = filterKeys.flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
    const result = await execFileAsync("git", [...readGitConfig, ...filterConfig, ...safeArgs], {
      cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true,
      encoding: "buffer", env: cleanGitEnv(),
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? ` (${error.code})` : "";
    throw new Error(`Git ${args[0] ?? "operation"} failed${code}; inspect the local repository before retrying`);
  }
}

async function gitText(root: string, args: string[], maxBuffer = 256 * 1024): Promise<string> {
  const bytes = await git(root, args, maxBuffer);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/, ""); }
  catch { throw new Error("Git returned invalid text; repository inspection is blocked"); }
}

async function gitStatus(root: string) {
  const bytes = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
  return bytes.length === 0;
}

async function repositoryRoot(workspace: string) {
  const root = await gitText(workspace, ["rev-parse", "--show-toplevel"]);
  const realRoot = realpathSync(root);
  if (process.platform === "win32" ? realRoot.toLowerCase() !== workspace.toLowerCase() : realRoot !== workspace) {
    throw new Error("Workspace root does not match the selected repository");
  }
}

function safeReadRepoFile(root: string, path: string, maxBytes: number): Buffer | null {
  const full = join(root, ...path.split("/"));
  let cursor = root;
  const segments = path.split("/");
  try {
    for (const [index, segment] of segments.entries()) {
      cursor = join(cursor, segment);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error("Repository path is not a regular file");
      }
    }
    return readSkillFileBytes(root, path, maxBytes);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function decodeText(bytes: Buffer | null, label: string) {
  if (bytes === null) return null;
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (content.includes("\0")) throw new Error();
    return content;
  } catch {
    throw new Error(`${label} must be a regular UTF-8 text file`);
  }
}

function secretContent(content: string) {
  return SECRET_PATTERNS.some(({ re }) => re.test(content))
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(content)
    || /\b(?:authorization\s*[:=]\s*["']?(?:bearer|basic)\s+\S+|(?:password|api[_-]?key|client_secret|refresh_token|access_token)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{8,})/i.test(content)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(content)
    || /(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/]|\/(?:home|Users)\/)[^\\/\s"']+/i.test(content);
}

function processEnvForTests(): Record<string, string> {
  const allow = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "CI"];
  return Object.fromEntries(allow.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

const testInputSchema = {
  type: "object",
  properties: {
    workspace: { type: "string", minLength: 1, maxLength: 4096 },
    vitest_entrypoint: { type: "string", minLength: 1, maxLength: 4096 },
    test_files: { type: "array", items: { type: "string", minLength: 1, maxLength: 240 }, minItems: 1, maxItems: 16 },
    environment: { type: "object", properties: {}, additionalProperties: true },
  },
  required: ["workspace", "vitest_entrypoint", "test_files", "environment"],
  additionalProperties: false,
};
const testOutputSchema = {
  type: "object",
  properties: {
    exit_code: { type: "integer", minimum: 0, maximum: 255 },
    stdout_bytes: { type: "integer", minimum: 0 },
    stderr_bytes: { type: "integer", minimum: 0 },
    passed_tests: { type: "integer", minimum: 0 },
    passed_files: { type: "integer", minimum: 0 },
    output_sha256: { type: "string", minLength: 64, maxLength: 64 },
  },
  required: ["exit_code", "stdout_bytes", "stderr_bytes", "output_sha256", "passed_tests", "passed_files"],
  additionalProperties: false,
};

// This fixed script runs only the reviewed Vitest entry point and positional paths.
// It returns hashes and byte counts, never test stdout/stderr or process errors.
const testRunner = `"use strict";
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync, lstatSync } = require("node:fs");
const { join, resolve } = require("node:path");
const input = JSON.parse(readFileSync(0, "utf8"));
const digest = value => createHash("sha256").update(value).digest("hex");
const reportPath = join(__dirname, "observed-results.json");
const args = [input.vitest_entrypoint, "run", "--reporter=json", "--outputFile", reportPath, "--passWithNoTests=false", ...input.test_files];
execFile(process.execPath, args, {
  cwd: input.workspace, env: input.environment, windowsHide: true,
  timeout: 120000, maxBuffer: ${MAX_OUTPUT_BYTES},
}, (error, stdout, stderr) => {
  const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || "");
  const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || "");
  const code = error && Number.isInteger(error.code) ? error.code : error ? 1 : 0;
  let passedTests = 0;
  let passedFiles = 0;
  let report = Buffer.alloc(0);
  try {
    const stat = lstatSync(reportPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ${MAX_OUTPUT_BYTES}) throw new Error("Unreviewable report");
    report = readFileSync(reportPath);
    const parsed = JSON.parse(report.toString("utf8"));
    const canonical = path => {
      const full = resolve(input.workspace, path);
      return process.platform === "win32" ? full.toLowerCase() : full;
    };
    const expected = input.test_files.map(canonical).sort();
    const actual = parsed.testResults.map(file => canonical(file.name)).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual) || parsed.success !== true
      || parsed.numTotalTests < 1 || parsed.numPassedTests !== parsed.numTotalTests
      || parsed.numFailedTests !== 0 || parsed.numPendingTests !== 0 || parsed.numTodoTests !== 0
      || !parsed.testResults.every(file => file.status === "passed" && file.assertionResults.length > 0
        && file.assertionResults.every(assertion => assertion.status === "passed"))) throw new Error("Incomplete observed evidence");
    passedTests = parsed.numPassedTests;
    passedFiles = parsed.testResults.length;
  } catch { /* Missing, skipped, extra or malformed results remain unverified. */ }
  process.stdout.write(JSON.stringify({
    exit_code: code, stdout_bytes: out.length, stderr_bytes: err.length,
    passed_tests: passedTests, passed_files: passedFiles,
    output_sha256: digest(Buffer.concat([out, Buffer.from([0]), err, Buffer.from([0]), report])),
  }));
});
`;

function executionArtifact(testFiles: readonly TestSource[]) {
  const manifest = {
    schemaVersion: 1,
    entrypoint: "run.cjs",
    files: ["run.cjs", ...testFiles.map((file) => `reviewed-tests/${file.path}`)],
    timeoutMs: 120_000,
    maxOutputBytes: 2_048,
    inputSchema: testInputSchema,
    outputSchema: testOutputSchema,
  };
  return SkillExecutionArtifact.fromFiles([
    { path: "SKILL.md", content: "# Reviewed contribution test runner\nRuns exact reviewed Vitest paths with full host trust; it is not sandboxed.\n" },
    { path: "execution.json", content: JSON.stringify(manifest) },
    { path: "run.cjs", content: testRunner },
    ...testFiles.map(({ path, content }) => ({ path: `reviewed-tests/${path}`, content })),
  ]);
}

const gitRunner = `"use strict";
const { execFile } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const input = JSON.parse(readFileSync(0, "utf8"));
execFile("git", input.argv, {
  cwd: input.cwd, env: input.environment, windowsHide: true,
  encoding: "buffer", maxBuffer: 65536,
}, (error, stdout, stderr) => {
  const out = Buffer.from(stdout || "");
  const err = Buffer.from(stderr || "");
  process.stdout.write(JSON.stringify({
    exit_code: error ? 1 : 0,
    stdout_base64: out.toString("base64"),
    output_sha256: createHash("sha256").update(out).update(err).digest("hex"),
  }));
});
`;

function gitExecutionArtifact(timeoutMs: number) {
  return SkillExecutionArtifact.fromFiles([
    { path: "SKILL.md", content: "# Approved contribution Git operation\nFull-trust Git and its configured hooks, filters, signing and credential helpers. Owned process tree, not a sandbox.\n" },
    { path: "run.cjs", content: gitRunner },
    { path: "execution.json", content: JSON.stringify({
      schemaVersion: 1, entrypoint: "run.cjs", files: ["run.cjs"],
      timeoutMs, maxOutputBytes: 96 * 1024,
      inputSchema: {
        type: "object", properties: {
          cwd: { type: "string" },
          argv: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 128 },
          environment: { type: "object", properties: {}, additionalProperties: true },
        }, required: ["cwd", "argv", "environment"], additionalProperties: false,
      },
      outputSchema: {
        type: "object", properties: {
          exit_code: { type: "integer", minimum: 0, maximum: 1 },
          stdout_base64: { type: "string", maxLength: 90000 },
          output_sha256: { type: "string", minLength: 64, maxLength: 64 },
        }, required: ["exit_code", "stdout_base64", "output_sha256"], additionalProperties: false,
      },
    }) },
  ]);
}

function parseRemote(value: string): Remote {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && !url.search && !url.hash) {
      const parts = url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/i, "").split("/");
      if (parts.length === 2 && !url.username && !url.password) {
        return { kind: "github", owner: parts[0], repo: parts[1], display: `github.com/${parts[0]}/${parts[1]}` };
      }
      if (url.username || url.password) return { kind: "unsupported", display: "credential-bearing origin URL (blocked)" };
    }
    if (url.protocol === "file:" && !url.search && !url.hash) {
      const path = resolve(decodeURIComponent(url.pathname));
      return { kind: "local", path, display: `local remote: ${path}` };
    }
  } catch { /* try scp-style SSH and local paths below */ }
  const ssh = /^(?:git@)?github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(trimmed);
  if (ssh) return { kind: "github", owner: ssh[1], repo: ssh[2], display: `github.com/${ssh[1]}/${ssh[2]}` };
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    const path = resolve(trimmed);
    return { kind: "local", path, display: `local remote: ${path}` };
  }
  return { kind: "unsupported", display: "unsupported origin (only GitHub HTTPS/SSH or an explicit local remote is supported)" };
}

function responseError(value: unknown): string | null {
  return value !== null && typeof value === "object" && "error" in value && typeof value.error === "string"
    ? value.error : null;
}

function messageFor(error: unknown) {
  if (!(error instanceof Error)) return "Contribution operation failed; inspect actual local and remote effects before retrying";
  const message = error.message
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:home|Users)\/)[^\s"'<>]+/gi, "[path]")
    .replace(/\b(?:https?|ssh):\/\/[^/\s@]+@/gi, "https://[redacted]@")
    .slice(0, 240);
  if (secretContent(message) || /[A-Za-z]:[\\/]|\/(?:home|Users)\//i.test(message)) {
    return "Contribution operation failed; inspect actual local and remote effects before retrying";
  }
  return message;
}

export class ContributionService {
  readonly #operations = new Map<string, Operation>();
  #closed = false;
  #starting = 0;

  constructor(readonly dependencies: ContributionDependencies) {}

  start(agentId: string, workspace: string, input: unknown) {
    this.#sweep();
    this.#allowed(agentId);
    const parsed = ContributionCreateInput.parse(input);
    if (this.#operations.size + this.#starting >= MAX_OPERATIONS) throw new Error("Contribution capacity reached; inspect, cancel or wait for expiry");
    const workspaceIdentity = identity(workspace);
    this.#starting++;
    return this.#startOperation(agentId, workspace, workspaceIdentity, parsed).finally(() => { this.#starting--; });
  }

  inspectOperation(id: string, agentId?: string) {
    const op = this.#operation(id, agentId);
    return {
      ...op.preview,
      operation_id: op.id,
      operation_type: "contribution",
      stage: op.stage,
      status: op.state,
      revision: op.revision,
      proposal_id: op.proposalId || null,
      expires_at: new Date(op.expiresAt).toISOString(),
      result: op.output ?? null,
      error: op.error ?? null,
      outcome: op.outcome ?? null,
      publication_authorized: false,
      execution_authorized: false,
      git_execution_evidence: op.gitEvidence ?? [],
      git_execution: {
        ownership: "Existing native process owner and staged runner; full host trust, not a sandbox",
        timeout_ms: this.dependencies.gitTimeoutMs ?? GIT_TIMEOUT_MS,
        effects: "Approved Git mutations may execute configured hooks, fsmonitor, checkout/clean filters, signing programs, transports and credential helpers. Their descendants are owned until bounded cleanup settlement; unverified cleanup blocks retry.",
        discovery: "Local reads only; fsmonitor, external diff and textconv disabled; no credential helper or remote transport runs before approval",
      },
    };
  }

  async requestCommit(id: string, agentId?: string) {
    const op = this.#operation(id, agentId);
    this.#allowed(op.agentId);
    if (op.state !== "finished" || op.outcome !== "succeeded" || !op.bundle || op.commit) {
      throw new Error("A passing, service-verified test run and exact local review bundle are required before commit");
    }
    await this.#verifySource(op);
    await this.#verifyCandidateFiles(op);
    const author = await gitText(op.worktree, ["var", "GIT_AUTHOR_IDENT"]);
    const committer = await gitText(op.worktree, ["var", "GIT_COMMITTER_IDENT"]);
    op.commitHooks = await this.#captureHooks(op.worktree, ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]);
    op.preview = {
      ...op.preview,
      commit: { message: op.input.commit_message, author, committer, hooks: op.commitHooks },
      exact_diff: op.bundle.diff,
      files: op.bundle.files,
      tests: op.bundle.test_execution,
      effect: "Writes one local commit on the isolated topic branch; each listed Git hook executes with full local trust",
    };
    return this.#requestStage(op, "commit");
  }

  async requestPush(id: string, agentId?: string) {
    const op = this.#operation(id, agentId);
    this.#allowed(op.agentId);
    if (op.state !== "finished" || op.outcome !== "succeeded" || !op.commit || op.stage !== "commit") {
      throw new Error("A verified local commit is required before requesting push");
    }
    await this.#verifySource(op);
    await this.#verifyCommitFiles(op, op.commit);
    const remote = await this.#remote(op);
    if (remote.kind === "unsupported") throw new Error(remote.display);
    op.remote = remote;
    op.pushHooks = await this.#captureHooks(op.workspace, ["pre-push"]);
    op.preview = {
      ...op.preview,
      destination: remote.display,
      branch: op.input.branch,
      commit: op.commit,
      refspec: `${op.commit}:refs/heads/${op.input.branch}`,
      command: "git push --force-with-lease=<exact topic ref>: origin <exact commit>:<exact topic ref>",
      force: false,
      create_only: true,
      remote_baseline: "must_not_exist",
      credentials: "Not invoked during discovery; configured Git credential/SSH helpers execute with full host trust only after approval",
      hooks: op.pushHooks,
      effect: "Atomically creates the exact topic ref only if absent. Empty expected-value lease prevents ALL existing-ref updates (including fast-forward). Hooks, transport and credential helpers execute with full host trust in the owned process tree.",
    };
    return this.#requestStage(op, "push");
  }

  async requestDraftPr(id: string, agentId?: string) {
    const op = this.#operation(id, agentId);
    this.#allowed(op.agentId);
    if (op.state !== "finished" || op.outcome !== "succeeded" || !op.commit || op.stage !== "push") {
      throw new Error("A completed push is required before requesting a draft pull request");
    }
    await this.#verifySource(op);
    await this.#verifyCommitFiles(op, op.commit);
    const remote = await this.#remote(op);
    if (remote.kind !== "github" || remote.owner.toLowerCase() !== op.input.destination.split("/")[0].toLowerCase()
      || remote.repo.toLowerCase() !== op.input.destination.split("/")[1].toLowerCase()) {
      throw new Error("GitHub origin does not match the reviewed destination");
    }
    const auth = this.dependencies.githubAuth();
    if ("error" in auth) throw new Error("GitHub credentials are unavailable; configure the existing GitHub integration first");
    const repo = await this.dependencies.githubFetch(auth, `/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}`);
    if (responseError(repo)) throw new Error("GitHub could not verify the selected destination");
    const base = (repo as { default_branch?: unknown })?.default_branch;
    if (typeof base !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(base)) {
      throw new Error("GitHub did not return a usable default branch");
    }
    const pullRequest = {
      title: op.input.commit_message,
      head: op.input.branch,
      base,
      body: this.#pullRequestBody(op),
      draft: true,
    };
    op.remote = remote;
    return this.#requestStage(op, "draft_pr", {
      pull_request: pullRequest,
      destination: `github.com/${remote.owner}/${remote.repo}`,
      effect: "Creates exactly one GitHub draft pull request; no merge or review submission",
    });
  }

  async approve(id: string) {
    const op = this.#operation(id);
    if (op.state !== "pending") throw new Error("Contribution operation is not pending; inspect its actual outcome");
    const approval = getPendingAction(op.proposalId);
    if (!approval || approval.status !== "pending") throw new Error("Approval is stale, already claimed or unavailable");
    let payload: unknown;
    try { payload = JSON.parse(approval.payload); } catch { throw new Error("Approval payload is invalid"); }
    const parsedPayload = z.strictObject({
      operation_id: z.uuid(), operation_type: z.literal("contribution"),
      stage: z.enum(["tests", "commit", "push", "draft_pr"]), revision: z.string().regex(/^[a-f0-9]{64}$/),
    }).safeParse(payload);
    if (!parsedPayload.success || parsedPayload.data.operation_id !== op.id || parsedPayload.data.stage !== op.stage
      || parsedPayload.data.revision !== op.revision) {
      throw new Error("Approval revision or stage is stale; inspect and request a fresh gate");
    }
    this.#allowed(op.agentId);
    op.state = "running";
    op.controller = new AbortController();
    const work = this.#apply(op);
    op.work = work;
    try {
      const output = await work;
      op.output = output;
      if (op.controller.signal.aborted) {
        op.state = "unknown";
        op.error = "Cancellation occurred during an operation; inspect actual effects and do not retry automatically";
        throw new Error(op.error);
      }
      op.state = "finished";
      op.outcome = "succeeded";
      op.error = undefined;
      return this.inspectOperation(id);
    } catch (error) {
      if (op.state !== "unknown") {
        op.state = "finished";
        op.outcome = "failed";
      }
      op.error ??= messageFor(error);
      throw new Error(op.error ?? "Contribution operation failed; inspect actual effects before retrying");
    } finally { op.work = undefined; }
  }

  async cancel(id: string, agentId?: string) {
    const op = this.#operation(id, agentId);
    if (op.work) {
      op.controller.abort();
      await op.work.catch(() => undefined);
      op.state = "unknown";
      op.outcome = undefined;
      op.error = "Cancellation after execution began; owned host settlement completed, external effects remain unknown; do not retry";
      return this.inspectOperation(id, agentId);
    }
    if (op.state === "pending") {
      op.controller.abort();
      op.state = "finished";
      op.outcome = "cancelled";
      op.error = "Cancelled before execution; no operation was started";
      this.#expireProposal(op);
      return this.inspectOperation(id, agentId);
    }
    if (op.state === "running") {
      op.controller.abort();
      if (op.state === "running") {
        op.state = "unknown";
        op.error = "Cancellation requested after execution began; inspect actual effects and do not retry automatically";
      }
      return this.inspectOperation(id, agentId);
    }
    throw new Error("Contribution operation is already terminal");
  }

  async close() {
    this.#closed = true;
    const active: Promise<unknown>[] = [];
    for (const op of this.#operations.values()) {
      if (op.work) {
        op.controller.abort();
        active.push(op.work.catch(() => undefined));
      } else if (op.state === "pending") {
        op.controller.abort();
        op.state = "finished";
        op.outcome = "cancelled";
        op.error = "App stopped before this approval was used; request fresh approval";
        this.#expireProposal(op);
      }
    }
    await Promise.all(active);
  }

  async #startOperation(agentId: string, workspace: string, workspaceIdentity: string, input: CreateInput) {
    this.#verifyWorkspaceRoot(workspace, workspaceIdentity);
    if (!this.#ownedProcessAvailable()) throw new Error("Owned process execution is unavailable on this host; repository tests are blocked");
    await repositoryRoot(workspace);
    const tracked = await gitText(workspace, ["ls-files", "--stage"]);
    if (/^160000 /m.test(tracked) || /(?:^|\t)\.gitmodules(?:\r?\n|$)/m.test(tracked)) {
      throw new Error("Submodule repositories require separate review and are not supported");
    }
    if (!(await gitStatus(workspace))) throw new Error("Repository worktree is dirty; isolate or resolve all changes first");
    const head = await gitText(workspace, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (head !== input.base_revision) throw new Error("Selected base revision is not the actual current HEAD");
    if ((await gitText(workspace, ["branch", "--list", input.branch])).trim()) {
      throw new Error("The requested topic branch already exists; choose a fresh branch");
    }
    if ((await gitText(workspace, ["for-each-ref", "--format=%(refname)", `refs/remotes/origin/${input.branch}`])).trim()) {
      throw new Error("The requested topic branch already exists on origin; choose a fresh branch");
    }
    const files: RepoFile[] = [];
    for (const file of input.files) {
      if (sourcePathPattern.test(file.path)) throw new Error("Sensitive or unsupported repository paths are blocked");
      const before = decodeText(await this.#baseFile(workspace, input.base_revision, file.path), file.path);
      const current = decodeText(safeReadRepoFile(workspace, file.path, 16_384), file.path);
      if (before !== current) throw new Error("Selected file bytes differ from the actual clean base revision");
      if (before === file.content) throw new Error(`Selected file has no change: ${file.path}`);
      files.push({ path: file.path, before, after: file.content });
    }
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    const tests: TestSource[] = [];
    let testBytes = 0;
    for (const path of input.test_files) {
      if (sourcePathPattern.test(path)) throw new Error("Sensitive test paths are not supported");
      const patch = filesByPath.get(path);
      const source = patch ? patch.after : decodeText(await this.#baseFile(workspace, input.base_revision, path), path);
      if (source === null) throw new Error(`Selected test file does not exist in the base revision: ${path}`);
      const bytes = Buffer.byteLength(source, "utf8");
      testBytes += bytes;
      if (bytes > MAX_TEST_FILE_BYTES || testBytes > MAX_TEST_BYTES) throw new Error("Selected test source exceeds the reviewed execution limit");
      if (secretContent(source)) throw new Error(`Sensitive markers detected in selected test source: ${path}`);
      const actual = decodeText(safeReadRepoFile(workspace, path, MAX_TEST_FILE_BYTES), path);
      if (actual !== (patch ? patch.before : source)) throw new Error("Selected test bytes differ from the exact base revision");
      tests.push({ path, content: source, sha256: HASH(source) });
    }
    const preparedFiles = files.map(({ path, before, after }) => ({ path, before, after }));
    const finalInput = {
      destination: input.destination, branch: input.branch, base_revision: input.base_revision,
      classification: input.classification, summary: input.summary, ownership: input.ownership,
      license_review: input.license_review, worktree: "clean" as const,
      tests: { status: "passed" as const, command: "PREVIEW ONLY — exact Vitest paths; not run", evidence: "PREVIEW ONLY — explicit full-trust test authorization required" },
      files: preparedFiles,
    };
    const sanitizedPreview = prepareContributionBundle(finalInput);
    if (!sanitizedPreview.ok) throw new Error("Contribution bundle is blocked by scope, rights, privacy, path or size checks");
    const operationId = randomUUID();
    const worktreeParent = join(workspace, "node_modules", ".cache", "jarela-contributions");
    if (!existsSync(join(workspace, "node_modules")) || lstatSync(join(workspace, "node_modules")).isSymbolicLink()) {
      throw new Error("A local unlinked node_modules directory is required to isolate and run repository tests");
    }
    const worktree = join(worktreeParent, operationId, "worktree");
    for (const path of [join(workspace, "node_modules", ".cache"), worktreeParent]) {
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Contribution worktree parent is not an unlinked directory");
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
    const previewPath = relative(workspace, worktree);
    try { await git(workspace, ["check-ignore", "-q", "--", previewPath]); }
    catch { throw new Error("The isolated test worktree must be Git-ignored; node_modules/.cache is expected"); }
    const testArtifact = executionArtifact(tests);
    const vitestEntrypoint = this.#vitestEntrypoint(workspace);
    const vitestSha256 = this.#vitestHash(vitestEntrypoint);
    const testHooks = await this.#captureHooks(workspace, ["post-checkout"]);
    const initialRevision = HASH(JSON.stringify({
      bundle_revision: sanitizedPreview.revision,
      test_artifact_revision: testArtifact.revision,
      test_files: tests.map(({ path, sha256 }) => ({ path, sha256 })),
      vitest_sha256: vitestSha256,
      hooks: testHooks,
      worktree,
      commit_message: input.commit_message,
      process_version: process.version,
      test_command: `${TEST_COMMAND} <exact selected paths>`,
    }));
    const preview = {
      ...sanitizedPreview,
      revision: initialRevision,
      checks: { ...sanitizedPreview.checks, tests: "not_run_execution_approval_required" },
      reported_tests: { status: "not_run", command: `${TEST_COMMAND} <exact selected paths>`, evidence: "Not run; pending explicit approval" },
      agent_id: agentId,
      workspace,
      current_branch: await gitText(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]),
      actual_head: head,
      repository_evidence: { status: "verified", worktree: "clean", selected_bytes_match_base: true },
      test_sources: tests,
      test_execution: {
        status: "not_run",
        executable: "Node runtime used by Jarela",
        argv: ["node_modules/vitest/vitest.mjs", "run", "--reporter=json", "--outputFile", "<owned-staging>/observed-results.json", "--passWithNoTests=false", ...tests.map((test) => test.path)],
        vitest_sha256: vitestSha256,
        timeout_ms: 120_000,
        output_policy: "Only exit code, output byte counts and SHA-256 are retained; stdout/stderr are never exposed",
        process: "Existing owned skill runner; full host trust, NOT sandboxed",
        hooks: ["post-checkout may run while creating the isolated worktree", "tests may access host files and network"],
        isolated_worktree: worktree,
        reviewed_hooks: testHooks,
        environment: Object.keys(processEnvForTests()).sort(),
        rights: "Separate explicit approval required; local agent tool permission is not approval",
      },
      review: {
        commit_message: input.commit_message,
        commit_effect: "Local commit runs configured pre-commit, prepare-commit-msg, commit-msg and post-commit hooks; hooks are not bypassed",
        push_effect: "Not authorized; separate exact push approval required",
        draft_pr_effect: "Not authorized; separate exact GitHub draft-PR approval required",
      },
      required_gates: ["full_trust_test_execution", "exact_local_commit_review", "push", "draft_pr"],
      publication_authorized: false,
      execution_authorized: false,
    };
    const operation: Operation = {
      id: operationId, agentId, workspace, workspaceIdentity, sourceBranch: preview.current_branch as string,
      input, files, tests, worktree,
      revision: initialRevision, stage: "tests", proposalId: "", state: "pending",
      expiresAt: this.#now() + SESSION_TTL_MS, controller: new AbortController(), preview,
      testArtifact, testHooks, vitestEntrypoint, vitestSha256,
    };
    this.#allowed(agentId);
    this.#checkRunnerIsolation(workspace);
    operation.proposalId = this.#createProposal(operation, "tests", operation.revision);
    this.#operations.set(operation.id, operation);
    return { operation_id: operation.id, proposal_id: operation.proposalId, status: "pending", stage: "tests", revision: operation.revision };
  }

  async #apply(op: Operation): Promise<unknown> {
    this.#allowed(op.agentId);
    this.#verifyWorkspace(op);
    if (this.#now() >= op.expiresAt || op.controller.signal.aborted) throw new Error("Contribution approval expired or was cancelled");
    switch (op.stage) {
      case "tests": return await this.#runTests(op);
      case "commit": return await this.#commit(op);
      case "push": return await this.#push(op);
      case "draft_pr": return await this.#createDraftPr(op);
    }
  }

  async #runTests(op: Operation) {
    this.#checkInputRevision(op);
    await this.#verifySource(op);
    if (this.#vitestHash(op.vitestEntrypoint) !== op.vitestSha256) {
      throw new Error("The reviewed Vitest runner changed after authorization; request a fresh test approval");
    }
    const branch = await gitText(op.workspace, ["branch", "--list", op.input.branch]);
    if (branch.trim()) throw new Error("The requested topic branch already exists; choose a fresh branch");
    const worktrees = await gitText(op.workspace, ["worktree", "list", "--porcelain"]);
    if (worktrees.split(/\r?\n/).some((line) => line === `branch refs/heads/${op.input.branch}`)) {
      throw new Error("The requested topic branch is already checked out in another worktree");
    }
    mkdirSync(dirname(op.worktree), { recursive: true });
    if (existsSync(op.worktree)) throw new Error("Isolated contribution worktree already exists");
    try {
      await this.#verifyHooks(op.workspace, ["post-checkout"], op.testHooks);
      await this.#ownedGit(op, op.workspace, ["worktree", "add", "--no-checkout", "-b", op.input.branch, op.worktree, op.input.base_revision]);
    } catch {
      op.state = "unknown";
      op.error = "Worktree creation or post-checkout hook failed; inspect local branch and worktree effects";
      throw new Error(op.error);
    }
    op.state = "unknown";
    await this.#verifyHooks(op.workspace, ["post-checkout"], op.testHooks);
    op.worktreeIdentity = identity(op.worktree);
    await repositoryRoot(op.worktree);
    const isolatedHooks = await this.#captureHooks(op.worktree, ["post-checkout"]);
    if (!this.#sameHookCode(isolatedHooks, op.testHooks)) {
      op.error = "Linked-worktree post-checkout hook differs from the reviewed hook; no checkout code was run";
      throw new Error(op.error);
    }
    await this.#ownedGit(op, op.worktree, ["-c", "core.autocrlf=false", "checkout", op.input.branch]);
    await this.#verifyHooks(op.worktree, ["post-checkout"], isolatedHooks);
    if (op.controller.signal.aborted) throw new Error("Test execution cancelled before the reviewed changes were applied");
    for (const file of op.files) this.#writeChange(op.worktree, file);
    const current = await gitText(op.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (current !== op.input.base_revision || !(await gitStatus(op.workspace))) {
      throw new Error("Repository or isolated worktree changed during staging");
    }
    const changed = await gitText(op.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!changed) throw new Error("Isolated worktree does not contain the reviewed change");
    const expectedPaths = op.files.map((file) => file.path).sort();
    const actualPaths = (await gitText(op.worktree, ["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"]))
      .split("\0").filter(Boolean).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new Error("Isolated worktree changes do not match the reviewed file selection");
    }
    await this.#verifyCandidateFiles(op);
    const testPolicy = this.#testPolicy(op);
    const binding = {
      agentId: op.agentId, runId: op.id, workspace: op.workspace,
      artifactRevision: op.testArtifact!.revision, inputDigest: skillInvocationDigest(JSON.stringify({
        workspace: op.worktree,
        vitest_entrypoint: op.vitestEntrypoint,
        test_files: op.tests.map((test) => test.path),
        environment: processEnvForTests(),
      })),
      runtimeVersion: process.version, timeoutMs: 120_000, maxOutputBytes: 2_048,
    };
    const inputJson = JSON.stringify({
      workspace: op.worktree,
      vitest_entrypoint: op.vitestEntrypoint,
      test_files: op.tests.map((test) => test.path),
      environment: processEnvForTests(),
    });
    const consent = new SkillRunConsent({ agentId: op.agentId, runId: op.id, workspace: op.workspace }, op.controller.signal);
    const proposal = consent.propose(binding);
    consent.decide(proposal.id, "approve");
    try {
      const run = await runStagedSkill({
        artifact: op.testArtifact!, inputJson, binding, consent, proposalId: proposal.id,
        signal: op.controller.signal, policy: testPolicy, owner: this.dependencies.processOwner?.() ?? createSkillProcessOwner(),
      });
      if (!run.cleanupVerified) {
        op.state = "unknown";
        op.error = "Owned test process cleanup is unverified; inspect host effects and do not retry";
        throw new Error(op.error);
      }
      if (run.status !== "succeeded" || op.controller.signal.aborted) {
        op.state = "unknown";
        op.error = "Approved tests failed or were cancelled; full-trust side effects are unknown and retry is blocked";
        throw new Error(op.error);
      }
      const parsedOutput = z.strictObject({
        exit_code: z.number().int().min(0).max(255),
        stdout_bytes: z.number().int().nonnegative(),
        stderr_bytes: z.number().int().nonnegative(),
        passed_tests: z.number().int().nonnegative(),
        passed_files: z.number().int().nonnegative(),
        output_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }).safeParse(run.output);
      if (!parsedOutput.success || parsedOutput.data.exit_code !== 0
        || parsedOutput.data.passed_tests < 1 || parsedOutput.data.passed_files !== op.tests.length) {
        op.state = "unknown";
        op.error = "Test runner returned incomplete evidence; outcome is unknown and retry is blocked";
        throw new Error(op.error);
      }
      const result = parsedOutput.data;
      const command = `${TEST_COMMAND} ${op.tests.map((test) => test.path).join(" ")}`;
      const evidence = `Vitest exit 0; ${result.passed_tests} passed assertion(s) across exactly ${result.passed_files} selected file(s); none skipped or pending; output sha256 ${result.output_sha256}; cleanup verified; artifact ${run.revision}`;
      op.testEvidence = { command, evidence };
      const bundle = prepareContributionBundle({
        destination: op.input.destination, branch: op.input.branch, base_revision: op.input.base_revision,
        classification: op.input.classification, summary: op.input.summary, ownership: op.input.ownership,
        license_review: op.input.license_review, worktree: "clean",
        tests: { status: "passed", command, evidence },
        files: op.files,
      });
      if (!bundle.ok || bundle.revision === undefined) {
        op.state = "unknown";
        op.error = "Observed test evidence could not produce the canonical sanitized review bundle";
        throw new Error(op.error);
      }
      await this.#verifyCandidateFiles(op);
      op.bundle = {
        ...bundle,
        checks: { ...bundle.checks, tests: "executed_by_approved_owned_process", worktree: "verified_isolated_worktree" },
        repository_evidence: { status: "verified", base: op.input.base_revision, branch: op.input.branch, selected_bytes: "exact" },
        test_execution: {
          status: "passed", command, evidence, cleanup_verified: true,
          output_sha256: result.output_sha256, isolated_worktree: op.worktree,
          passed_tests: result.passed_tests, passed_files: result.passed_files,
        },
        test_sources: op.tests,
        publication_authorized: false,
        execution_authorized: false,
      };
      op.bundleRevision = bundle.revision;
      op.revision = HASH(JSON.stringify({
        bundle_revision: bundle.revision,
        test_artifact_revision: op.testArtifact!.revision,
        vitest_sha256: op.vitestSha256,
        test_evidence: evidence,
        test_command: command,
        test_output_sha256: result.output_sha256,
      }));
      op.preview = {
        ...op.preview,
        ...op.bundle,
        operation_id: op.id,
        operation_type: "contribution",
        stage: "tests",
        status: "finished",
        revision: op.revision,
        test_execution: op.bundle.test_execution,
        review: { ...(op.preview.review as Record<string, unknown>), commit_message: op.input.commit_message },
        required_gates: ["exact_local_commit_review", "push", "draft_pr"],
        execution_authorized: false,
        publication_authorized: false,
      };
      return { tests: "passed", revision: op.revision, cleanup_verified: true, output_sha256: result.output_sha256 };
    } finally { consent.close(); }
  }

  async #commit(op: Operation) {
    this.#assertExactBundle(op);
    await this.#verifyCandidateFiles(op);
    const identityBefore = await gitText(op.worktree, ["rev-parse", "HEAD"]);
    if (identityBefore !== op.input.base_revision) throw new Error("Topic branch no longer points at the reviewed base");
    const status = await gitText(op.worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!status) throw new Error("Reviewed patch is missing from the isolated worktree");
    await this.#verifyHooks(op.worktree, ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"], op.commitHooks ?? []);
    op.state = "unknown";
    const staged = await this.#ownedGit(op, op.worktree, ["add", "--", ...op.files.map((file) => file.path)]);
    void staged;
    const stagedPaths = (await gitText(op.worktree, ["diff", "--cached", "--name-only", "--no-renames", "-z"]))
      .split("\0").filter(Boolean).sort();
    const expected = op.files.map((file) => file.path).sort();
    if (JSON.stringify(stagedPaths) !== JSON.stringify(expected)) throw new Error("Staged paths differ from the exact reviewed bundle");
    const beforeCommit = await git(op.worktree, ["diff", "--cached", "--binary", "--no-ext-diff"], MAX_OUTPUT_BYTES);
    const expectedDiff = (op.bundle!.diff as string);
    // The canonical preview is the review contract; this recheck compares tree bytes and paths, not Git's formatting.
    if (beforeCommit.length === 0 || !expectedDiff) throw new Error("No canonical reviewed patch is available");
    op.state = "unknown";
    try {
      await this.#ownedGit(op, op.worktree, ["commit", "-m", op.input.commit_message]);
    } catch {
      op.state = "unknown";
      op.error = "Git commit or a configured hook failed; inspect HEAD, hooks and side effects before any retry";
      throw new Error(op.error);
    }
    const commit = await gitText(op.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const parent = await gitText(op.worktree, ["rev-parse", "--verify", "HEAD^"]);
    if (parent !== op.input.base_revision) {
      op.state = "unknown";
      op.error = "Commit ancestry differs from the reviewed base; inspect local repository effects";
      throw new Error(op.error);
    }
    await this.#verifyCommitFiles(op, commit);
    op.commit = commit;
    const commitDiff = await gitText(op.worktree, ["diff", "--name-only", "--no-renames", `${op.input.base_revision}..${commit}`, "-z"]);
    if (JSON.stringify(commitDiff.split("\0").filter(Boolean).sort()) !== JSON.stringify(op.files.map((file) => file.path).sort())) {
      op.state = "unknown";
      op.error = "Committed paths differ from the reviewed bundle; inspect before retrying";
      throw new Error(op.error);
    }
    return { commit, branch: op.input.branch, revision: op.revision, hooks_bypassed: false };
  }

  async #push(op: Operation) {
    if (!op.commit) throw new Error("No verified local commit is available");
    await this.#verifySource(op);
    await this.#verifyCommitFiles(op, op.commit);
    const remote = await this.#remote(op);
    if (remote.kind === "unsupported") throw new Error(remote.display);
    if (JSON.stringify(remote) !== JSON.stringify(op.remote)) throw new Error("Remote destination changed after push review");
    await this.#verifyHooks(op.workspace, ["pre-push"], op.pushHooks ?? []);
    if (await this.#remoteHead(op)) throw new Error("Remote baseline changed: topic ref already exists; no push was attempted");
    op.state = "unknown";
    try {
      await this.#ownedGit(op, op.workspace, [
        "push", `--force-with-lease=refs/heads/${op.input.branch}:`, "origin",
        `${op.commit}:refs/heads/${op.input.branch}`,
      ]);
    } catch {
      op.state = "unknown";
      op.error = "Push failed or timed out; remote effects are unknown and automatic retry is prohibited";
      throw new Error(op.error);
    }
    const remoteHead = await this.#remoteHead(op);
    if (remoteHead !== op.commit) {
      op.state = "unknown";
      op.error = "Push returned success but the remote ref does not match the reviewed commit";
      throw new Error(op.error);
    }
    return { pushed: true, destination: remote.display, branch: op.input.branch, commit: op.commit };
  }

  async #createDraftPr(op: Operation) {
    if (!op.commit || !op.remote || op.remote.kind !== "github") throw new Error("Verified GitHub push evidence is required");
    const remote = op.remote;
    await this.#verifySource(op);
    await this.#verifyCommitFiles(op, op.commit);
    if (await this.#remoteHead(op) !== op.commit) {
      op.state = "unknown";
      throw new Error("Remote topic branch no longer matches the reviewed commit");
    }
    const auth = this.dependencies.githubAuth();
    if ("error" in auth) throw new Error("GitHub credentials are unavailable; draft PR was not attempted");
    const request = op.preview.pull_request as { title: string; head: string; base: string; body: string; draft: true };
    const repo = await this.dependencies.githubFetch(auth, `/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}`);
    if (responseError(repo) || (repo as { default_branch?: unknown })?.default_branch !== request.base) {
      op.state = "unknown";
      throw new Error("GitHub base branch changed after draft-PR review; request a fresh preview");
    }
    let response: unknown;
    try {
      response = await this.dependencies.githubFetch(auth, `/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}/pulls`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/vnd.github+json" },
        body: JSON.stringify(request),
      });
    } catch {
      op.state = "unknown";
      op.error = "GitHub response was unavailable; draft PR creation outcome is unknown and retry is prohibited";
      throw new Error(op.error);
    }
    if (responseError(response)) {
      op.state = "unknown";
      op.error = "GitHub rejected or ambiguously processed draft PR creation; inspect GitHub before retrying";
      throw new Error(op.error);
    }
    const pr = response as { number?: unknown; draft?: unknown; html_url?: unknown; head?: { ref?: unknown; sha?: unknown }; base?: { ref?: unknown } };
    if (!Number.isInteger(pr?.number) || pr.draft !== true || pr.head?.ref !== op.input.branch || pr.head?.sha !== op.commit
      || pr.base?.ref !== request.base || typeof pr.html_url !== "string") {
      op.state = "unknown";
      op.error = "GitHub response did not verify the exact draft pull request; inspect before retrying";
      throw new Error(op.error);
    }
    return { draft_pr: true, number: pr.number, url: pr.html_url, head: op.input.branch, commit: op.commit, base: request.base };
  }

  #testPolicy(op: Operation, artifact = op.testArtifact!) {
    const manifest = artifact.getManifest();
    const target = { agent_id: op.agentId, workspace: op.workspace, revision: artifact.revision, timeout_ms: manifest.timeoutMs, max_output_bytes: manifest.maxOutputBytes };
    const evaluate = () => {
      const allowed = this.dependencies.allowed(op.agentId);
      const decision = resolveSkillExecutionConsentRequirement(target, allowed);
      return {
        executeAllowed: allowed,
        safeMode: resolveSafetyMode() === "safe",
        blocked: decision.kind === "blocked" || decision.kind === "require_workflow_consent"
          || !this.#ownedProcessAvailable(),
      };
    };
    if (!this.#ownedProcessAvailable()) throw new Error("Owned process execution is unavailable on this host");
    const before = evaluate();
    if (before.blocked || !before.executeAllowed || before.safeMode) {
      throw new Error("Full-trust test execution is blocked by current agent permission, safety mode or host process-owner policy");
    }
    return evaluate;
  }

  async #ownedGit(op: Operation, cwd: string, argv: string[]) {
    if (op.controller.signal.aborted) throw new Error("Approved Git operation cancelled before launch");
    const artifact = gitExecutionArtifact(this.dependencies.gitTimeoutMs ?? GIT_TIMEOUT_MS);
    const environment = { ...cleanGitEnv() } as Record<string, string>;
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SSH_AUTH_SOCK"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name]!;
    }
    const inputJson = JSON.stringify({ cwd, argv, environment });
    const manifest = artifact.getManifest();
    const binding = {
      agentId: op.agentId, runId: op.id, workspace: op.workspace,
      artifactRevision: artifact.revision, inputDigest: skillInvocationDigest(inputJson),
      runtimeVersion: process.version, timeoutMs: manifest.timeoutMs, maxOutputBytes: manifest.maxOutputBytes,
    };
    const consent = new SkillRunConsent({ agentId: op.agentId, runId: op.id, workspace: op.workspace }, op.controller.signal);
    const proposal = consent.propose(binding);
    consent.decide(proposal.id, "approve");
    const owner = this.dependencies.processOwner?.() ?? createSkillProcessOwner();
    // Keep ownership through the runner's settlement, even if the operation becomes unknown.
    op.state = "unknown";
    const work = runStagedSkill({
      artifact, inputJson, binding, consent, proposalId: proposal.id,
      signal: op.controller.signal, policy: this.#testPolicy(op, artifact), owner,
    });
    op.hostWork = work;
    try {
      const run = await work;
      const evidence = { command: argv[0] === "-c" ? argv[2] : argv[0], status: run.status, cleanup_verified: run.cleanupVerified };
      op.gitEvidence = [...(op.gitEvidence ?? []), evidence].slice(-16);
      if (run.status !== "succeeded" || !run.cleanupVerified || op.controller.signal.aborted) {
        op.state = "unknown";
        const code = run.status === "succeeded" ? "cancelled_after_exit"
          : /^[a-z_]+$/.test(run.error) ? run.error : "execution_failed";
        throw new Error(`Approved Git execution failed (${code}; exit=${run.exitCode}; cleanup=${run.cleanupVerified}); external effects may be unknown; retry blocked`);
      }
      const parsed = z.strictObject({
        exit_code: z.number().int().min(0).max(1),
        stdout_base64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        output_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }).safeParse(run.output);
      if (!parsed.success || parsed.data.exit_code !== 0) {
        evidence.status = "failed";
        op.state = "unknown";
        throw new Error("Approved Git command or hook failed; inspect actual effects; retry blocked");
      }
      op.gitEvidence[op.gitEvidence.length - 1] = { ...evidence, output_sha256: parsed.data.output_sha256 };
      return Buffer.from(parsed.data.stdout_base64, "base64");
    } finally {
      consent.close();
      op.hostWork = undefined;
    }
  }

  #vitestEntrypoint(workspace: string) {
    let current = workspace;
    while (true) {
      const modules = join(current, "node_modules");
      const candidate = join(modules, "vitest", "vitest.mjs");
      try {
        const modulesStat = lstatSync(modules);
        const packageStat = lstatSync(dirname(candidate));
        if (modulesStat.isSymbolicLink() || !modulesStat.isDirectory()
          || packageStat.isSymbolicLink() || !packageStat.isDirectory()) {
          throw new Error("Vitest package paths must not be symbolic links");
        }
        this.#vitestHash(candidate);
        return candidate;
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          // Keep walking the standard Node module lookup ancestors.
        } else if (error instanceof Error && error.message.includes("symbolic link")) throw error;
        else throw new Error("Vitest package must be safely inspectable");
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    throw new Error("A workspace-local Vitest installation is required; tests were not run");
  }

  #vitestHash(entrypoint: string) {
    if (realpathSync(entrypoint) !== entrypoint) throw new Error("Vitest entry point must not use a symbolic link");
    const parent = dirname(entrypoint);
    const stat = lstatSync(entrypoint);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error("Vitest entry point is not a bounded regular file");
    }
    const bytes = readSkillFileBytes(parent, basename(entrypoint), 1024 * 1024);
    return HASH(bytes);
  }

  async #captureHooks(root: string, names: string[]): Promise<HookSource[]> {
    const hooks: HookSource[] = [];
    for (const name of names) {
      const hookPath = resolve(root, await gitText(root, ["rev-parse", "--git-path", `hooks/${name}`]));
      let stat;
      try { stat = lstatSync(hookPath); }
      catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw new Error("Could not safely inspect configured Git hooks");
      }
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TEST_FILE_BYTES) {
        throw new Error("Configured Git hook is linked, non-regular or exceeds the reviewed hook size limit");
      }
      const parent = dirname(hookPath);
      const realParent = realpathSync(parent);
      if (process.platform === "win32" ? realParent.toLowerCase() !== parent.toLowerCase() : realParent !== parent) {
        throw new Error("Configured Git hook directory is linked");
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(readSkillFileBytes(parent, basename(hookPath), MAX_TEST_FILE_BYTES));
      } catch {
        throw new Error("Configured Git hook is not a safely reviewable UTF-8 script");
      }
      if (secretContent(content)) throw new Error("Sensitive markers in configured Git hooks block contribution actions");
      hooks.push({ name, path: hookPath, content, sha256: HASH(content), executable: (stat.mode & 0o111) !== 0 });
    }
    return hooks;
  }

  async #verifyHooks(root: string, names: string[], expected: HookSource[]) {
    const current = await this.#captureHooks(root, names);
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error("Configured Git hook bytes changed after exact review");
    }
  }

  #sameHookCode(left: HookSource[], right: HookSource[]) {
    const stable = (hooks: HookSource[]) => hooks.map(({ name, content, sha256, executable }) => ({ name, content, sha256, executable }));
    return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
  }

  async #verifyCandidateFiles(op: Operation) {
    await this.#verifySource(op);
    if (!op.worktreeIdentity || identity(op.worktree) !== op.worktreeIdentity) {
      throw new Error("Isolated contribution worktree changed identity");
    }
    await repositoryRoot(op.worktree);
    if (await gitText(op.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]) !== op.input.branch) {
      throw new Error("Isolated worktree is no longer on the reviewed topic branch");
    }
    const base = await gitText(op.worktree, ["rev-parse", "HEAD"]);
    if (base !== op.input.base_revision) throw new Error("Topic branch base changed after tests");
    const status = await gitText(op.worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!status) throw new Error("Reviewed candidate disappeared after tests");
    for (const file of op.files) {
      const actual = decodeText(safeReadRepoFile(op.worktree, file.path, 16_384), file.path);
      if (actual !== file.after) throw new Error("Candidate bytes changed after test approval");
    }
    for (const test of op.tests) {
      const actual = decodeText(safeReadRepoFile(op.worktree, test.path, MAX_TEST_FILE_BYTES), test.path);
      if (actual !== test.content) throw new Error("Selected test bytes changed after test approval");
    }
    const untracked = await gitText(op.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const allowedUntracked = op.files.filter((file) => file.before === null).map((file) => file.path).sort();
    if (JSON.stringify(untracked.split("\0").filter(Boolean).sort()) !== JSON.stringify(allowedUntracked)) {
      throw new Error("Tests created unreviewed untracked files; inspect them before requesting commit");
    }
    const paths = (await gitText(op.worktree, ["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"]))
      .split("\0").filter(Boolean).sort();
    if (JSON.stringify(paths) !== JSON.stringify(op.files.map((file) => file.path).sort())) {
      throw new Error("Candidate diff paths changed after test approval");
    }
  }

  #assertExactBundle(op: Operation) {
    this.#verifyWorkspace(op);
    if (!op.bundle || !op.testEvidence || op.bundle.revision !== op.bundleRevision) {
      throw new Error("The exact observed review bundle is unavailable");
    }
  }

  async #verifyCommitFiles(op: Operation, commit: string) {
    if (!op.worktreeIdentity || identity(op.worktree) !== op.worktreeIdentity) {
      throw new Error("Isolated contribution worktree changed identity");
    }
    const actualPaths = (await gitText(op.worktree, ["diff", "--name-only", "--no-renames", `${op.input.base_revision}..${commit}`, "-z"]))
      .split("\0").filter(Boolean).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(op.files.map((file) => file.path).sort())) {
      throw new Error("Commit paths differ from the exact reviewed bundle");
    }
    for (const file of op.files) {
      const actual = decodeText(await this.#baseFile(op.worktree, commit, file.path), file.path);
      if (actual !== file.after) throw new Error("Committed bytes differ from the exact reviewed bundle");
    }
  }

  async #remote(op: Operation): Promise<Remote> {
    this.#verifyWorkspace(op);
    const rawUrl = await gitText(op.workspace, ["config", "--get", "remote.origin.url"]);
    if (!rawUrl) throw new Error("Git origin is not configured");
    const effectiveUrl = await gitText(op.workspace, ["remote", "get-url", "origin"]);
    const pushUrl = await gitText(op.workspace, ["remote", "get-url", "--push", "origin"]);
    if (pushUrl !== effectiveUrl) throw new Error("A separate origin push URL is not supported");
    if (!effectiveUrl) throw new Error("Git origin is not configured");
    const rawRemote = parseRemote(rawUrl);
    const effectiveRemote = parseRemote(effectiveUrl);
    const rewritten = rawUrl !== effectiveUrl;
    if (rewritten && !this.dependencies.allowGitUrlRewriteForTests) {
      if (rawRemote.kind !== "github" || effectiveRemote.kind !== "github"
        || rawRemote.owner.toLowerCase() !== effectiveRemote.owner.toLowerCase()
        || rawRemote.repo.toLowerCase() !== effectiveRemote.repo.toLowerCase()) {
        throw new Error("Git origin URL rewrite changes the reviewed destination and is blocked");
      }
    }
    const remote = rewritten && this.dependencies.allowGitUrlRewriteForTests && rawRemote.kind === "github"
      ? rawRemote
      : effectiveRemote;
    if (remote.kind === "github") {
      const [owner, repo] = op.input.destination.split("/");
      if (owner.toLowerCase() !== remote.owner.toLowerCase() || repo.toLowerCase() !== remote.repo.toLowerCase()) {
        throw new Error("GitHub origin does not match the reviewed destination");
      }
    }
    return remote;
  }

  #ownedProcessAvailable() {
    return this.dependencies.ownedProcessAvailable?.() ?? getSkillProcessOwnerAvailability().available;
  }

  async #remoteHead(op: Operation) {
    const bytes = await this.#ownedGit(op, op.workspace, ["ls-remote", "--refs", "origin", `refs/heads/${op.input.branch}`]);
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim().split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return "";
    if (lines.length !== 1 || !new RegExp(`^[a-f0-9]{40}(?:[a-f0-9]{24})?\\s+refs/heads/${op.input.branch}$`).test(lines[0])) {
      throw new Error("Remote ref evidence is ambiguous; no publication is permitted");
    }
    return lines[0].split(/\s+/)[0] ?? "";
  }

  async #baseFile(root: string, revision: string, path: string): Promise<Buffer | null> {
    const listing = await gitText(root, ["ls-tree", "-z", revision, "--", path], 32 * 1024);
    if (!listing) return null;
    const entry = listing.split("\0").filter(Boolean);
    if (entry.length !== 1) throw new Error("Selected base path is ambiguous");
    const [mode, type, objectId] = entry[0].split(/\s+/);
    if (type !== "blob" || mode !== "100644") throw new Error("Selected base path is not a regular non-executable text file");
    return await git(root, ["cat-file", "blob", objectId], Math.max(16_384, MAX_TEST_FILE_BYTES));
  }

  #writeChange(root: string, file: RepoFile) {
    const full = join(root, ...file.path.split("/"));
    const current = decodeText(safeReadRepoFile(root, file.path, 16_384), file.path);
    if (current !== file.before) throw new Error("Isolated file bytes differ from the selected base");
    let cursor = root;
    for (const segment of file.path.split("/").slice(0, -1)) {
      cursor = join(cursor, segment);
      try {
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Target directory is not a regular directory");
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
        mkdirSync(cursor);
      }
    }
    if (file.after === null) {
      rmSync(full);
    } else {
      writeFileSync(full, file.after, { encoding: "utf8", flag: current === null ? "wx" : "w" });
    }
  }

  #verifyWorkspace(op: Operation) {
    this.#verifyWorkspaceRoot(op.workspace, op.workspaceIdentity);
  }

  async #verifySource(op: Operation) {
    this.#verifyWorkspace(op);
    await repositoryRoot(op.workspace);
    if (!(await gitStatus(op.workspace))
      || await gitText(op.workspace, ["rev-parse", "--verify", "HEAD^{commit}"]) !== op.input.base_revision
      || await gitText(op.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]) !== op.sourceBranch) {
      throw new Error("Source repository changed after the contribution preview");
    }
  }

  #verifyWorkspaceRoot(workspace: string, expectedIdentity: string) {
    if (identity(workspace) !== expectedIdentity) throw new Error("Selected workspace changed identity");
  }

  #checkInputRevision(op: Operation) {
    if (op.revision !== op.preview.revision) throw new Error("Contribution review revision changed");
  }

  #pullRequestBody(op: Operation) {
    return `## Summary\n${op.input.summary}\n\n## Validation\n${op.testEvidence?.command ?? "No observed test evidence"}\n\n${op.testEvidence?.evidence ?? "Not run"}\n\n## Review bundle\nRevision: ${op.revision}\nBase: ${op.input.base_revision}`;
  }

  #requestStage(op: Operation, stage: ContributionStage, extra: Record<string, unknown> = {}) {
    if (op.state === "pending" || op.state === "running") throw new Error("Another approval is already pending or running");
    const nextRevision = HASH(JSON.stringify({ previous_revision: op.revision, stage, preview: op.preview, extra }));
    const nextPreview = {
      ...op.preview,
      ...extra,
      operation_id: op.id,
      operation_type: "contribution",
      stage,
      status: "pending",
      revision: nextRevision,
      required_gates: ["approve_exact_preview"],
      publication_authorized: false,
      execution_authorized: false,
    };
    const proposalId = this.#createProposal(op, stage, nextRevision);
    op.stage = stage;
    op.state = "pending";
    op.outcome = undefined;
    op.error = undefined;
    op.output = undefined;
    op.controller = new AbortController();
    op.expiresAt = this.#now() + SESSION_TTL_MS;
    op.revision = nextRevision;
    op.preview = nextPreview;
    op.proposalId = proposalId;
    return { operation_id: op.id, proposal_id: op.proposalId, status: "pending", stage, revision: op.revision };
  }

  #createProposal(op: Operation, stage: ContributionStage, revision: string) {
    return createPendingAction({
      agent_id: op.agentId,
      kind: "authoring_operation",
      payload: { operation_id: op.id, operation_type: "contribution", stage, revision },
      reason: `Review exact contribution ${stage}; each lifecycle stage requires independent approval`,
    }).id;
  }

  #expireProposal(op: Operation) {
    if (op.proposalId && getPendingAction(op.proposalId)?.status === "pending") {
      setActionStatus(op.proposalId, "denied", { error: "Contribution operation cancelled or expired" });
    }
  }

  #checkRunnerIsolation(workspace: string) {
    const staging = resolve(getDataDir(), "skill-runs");
    const candidates = [
      getConfig().toolsDir,
      join(getDataDir(), "providers"),
      ...listSkillRepos().map((repo) => repo.path),
    ];
    if (candidates.some((path) => inside(resolve(path), staging) || inside(staging, resolve(path)))) {
      throw new Error("Owned test staging overlaps a configured full-trust autoload directory");
    }
    if (inside(workspace, staging) || inside(staging, workspace)) {
      throw new Error("Owned test staging overlaps the selected repository");
    }
  }

  #allowed(agentId: string) {
    if (this.#closed || !this.dependencies.allowed(agentId)) {
      throw new Error("Contribution operation is not currently permitted by agent, category or safety policy");
    }
  }

  #operation(id: string, agentId?: string) {
    this.#sweep();
    const op = this.#operations.get(id);
    if (!op || this.#now() >= op.expiresAt) throw new Error("Contribution operation expired or belongs to a previous app instance");
    if (agentId !== undefined && op.agentId !== agentId) throw new Error("Contribution operation belongs to another agent");
    return op;
  }

  #sweep() {
    for (const op of this.#operations.values()) {
      if (this.#now() < op.expiresAt) continue;
      if (op.work) {
        op.controller.abort();
        op.state = "unknown";
        op.error = "Operation expired while running; owned settlement is awaited; external effects are unknown";
      } else if (op.state === "pending") {
        op.controller.abort();
        op.state = "finished";
        op.outcome = "cancelled";
        op.error = "Contribution operation expired; request fresh approval";
        this.#expireProposal(op);
      } else if (op.state === "running") {
        op.controller.abort();
        op.state = "unknown";
        op.error = "Operation expired while running; inspect local and remote effects before retrying";
      } else {
        this.#operations.delete(op.id);
      }
    }
  }

  #now() { return this.dependencies.now?.() ?? Date.now(); }
}

const SERVICE_KEY = Symbol.for("@jarela/contribution-service");
type GlobalService = typeof globalThis & { [SERVICE_KEY]?: ContributionService };
export function contributionService() {
  const global = globalThis as GlobalService;
  return global[SERVICE_KEY] ??= new ContributionService({
    allowed(agentId) {
      const agent = getAgentConfig(agentId);
      return !!agent && getAgentTools(agent).includes("request_contribution_tests")
        && !disabledCategories().has("Config")
        && !isMasterKeyLocked() && !isScreenLocked() && resolveSafetyMode() !== "safe";
    },
    githubAuth() { return resolvePackageAuth<GithubAuth>("github"); },
    ownedProcessAvailable() { return getSkillProcessOwnerAvailability().available; },
    githubFetch(auth, path, init) { return githubFetch(auth, path, init); },
  });
}

export async function inspectContributionOperation(id: string, agentId?: string) {
  return contributionService().inspectOperation(id, agentId);
}

export async function requestContributionStart(agentId: string, workspace: string, input: unknown) {
  return contributionService().start(agentId, workspace, input);
}
