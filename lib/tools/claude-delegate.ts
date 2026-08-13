// `claude_delegate` / `claude_delegate_status` — delegate a feature-scoped
// coding task to a local Claude Code CLI process, with full tool access
// (Read/Write/Edit/Bash/Skill/etc.), inside the calling agent's active
// workspace (ADR-0071).
//
// This supersedes an earlier, separately-loaded external `.cjs` tool that
// implemented the same idea against ADR-0013's external-tool contract:
// folded into the `workspace_*` family instead of a standalone black box,
// gated by this repo's own `JARELA_TOOL_SAFETY` (the external version
// always spawned with `--permission-mode bypassPermissions`, with no
// safety-mode integration at all), and every call returns a git-diff
// summary so the caller has a structured, checkable account of what
// changed instead of Claude's own prose.
//
// Sessions persist per project (`lib/stores/claude-delegate-sessions.ts`)
// so the sub-agent accumulates long-term context for that project across
// many separate delegate calls. Memory sync
// (`lib/tools/claude-memory-bridge.ts`) round-trips Claude's own
// `~/.claude/projects/.../memory/*.md` files against a
// `claude-sync:<hash>` namespace in this app's own `memory_store`.
//
// Background mode (background: true) spawns without blocking and returns
// a job_id immediately; poll with `claude_delegate_status`.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "./langchain-package";
import { currentWorkspace, type ToolConfig } from "./workspace-context";
import { resolveSafetyMode } from "./safety";
import { resolveSubprocessEnv } from "./subprocess-env";
import { gitDiffSummary } from "./git-probe";
import { getClaudeCodeConfig } from "./claude-code-config";
import { getSession, rememberSession } from "@/lib/stores/claude-delegate-sessions";
import * as bridge from "./claude-memory-bridge";
import * as jobs from "./claude-delegate-jobs";

const DEFAULT_TIMEOUT_S = 600;

const DESIGN_QA_PROMPT = `
PARENT-AGENT INTEGRATION CONTRACT

You are running as a sub-agent inside a parent agent's loop. The parent
will read your final response and may relay parts of it to a human user.

When you encounter a design decision with non-trivial tradeoffs — multiple
viable approaches, ambiguous requirements, choices that shape future
architecture, or anything where guessing wrong is expensive — STOP, do
not guess, and structure your response as:

## Design questions
1. <Question with brief context. List the options you'd consider and the tradeoff between them.>
2. ...

## Progress so far
<Concise summary of what you've already done in this session: files
touched, commands run, decisions already made.>

## Awaiting answers before continuing.

Surface the questions BEFORE making the decision yourself. The parent
will return with answers in a follow-up call (resumed automatically via
the same project/feature), and you'll continue from where you stopped.

If you have NO design questions, proceed normally and skip these
headings entirely. Use this contract only when you genuinely need human
input — not for trivial style choices you can decide on your own.
`.trim();

function claudeBin(): string {
  return getClaudeCodeConfig().bin;
}

function projectKey(cwd: string, feature?: string): string {
  const root = path.resolve(cwd);
  return feature && feature.trim() ? `${root}::${feature.trim()}` : root;
}

// ── permission-mode / safety-mode gate (ADR-0071) ─────────────────────────

export type SafetyGate =
  | { blocked: true; safetyMode: "safe" }
  | { blocked: false; safetyMode: "mostly_safe" | "bypass"; permissionMode: string };

export function resolveSafetyGate(requestedPermissionMode: string | undefined, allowUnsafe: boolean): SafetyGate {
  const safetyMode = resolveSafetyMode();
  if (safetyMode === "safe") return { blocked: true, safetyMode };
  if (safetyMode === "bypass") {
    return { blocked: false, safetyMode, permissionMode: requestedPermissionMode ?? "bypassPermissions" };
  }
  // mostly_safe (default): force read-only unless the caller explicitly
  // escalates for this one call — mirrors `local_exec`'s `allow_unsafe`.
  // Uses "dontAsk" rather than "default": it's the mode Claude Code's own
  // docs document for headless auto-deny ("auto-denies every tool call
  // that would otherwise prompt you… the session never waits for input"),
  // confirmed empirically to allow reads while cleanly denying writes/exec
  // with no hang — the same behavior "default" happened to show in
  // headless mode, but without a documented guarantee behind it.
  if (allowUnsafe) {
    return { blocked: false, safetyMode, permissionMode: requestedPermissionMode ?? "bypassPermissions" };
  }
  return { blocked: false, safetyMode, permissionMode: "dontAsk" };
}

// ── stream-json parsing (ported from the prior external tool) ────────────

interface StreamEvent {
  type?: string;
  subtype?: string;
  model?: string;
  message?: { content?: Array<Record<string, unknown>> };
  [k: string]: unknown;
}

interface RawClaudeResult {
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  // Undocumented as of CLI 2.1.133 (no published stream-json schema exists —
  // see anthropics/claude-code#24594) — treat as best-effort, not a stable
  // contract. Confirmed present empirically on every denied tool call.
  permission_denials?: unknown[];
  _model?: string;
  _steps?: string[];
  [k: string]: unknown;
}

function summarizeInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  switch (toolName) {
    case "Read": case "Write": case "Edit": return String(i.file_path ?? "");
    case "Bash": return String(i.command ?? "").replace(/\s+/g, " ").slice(0, 100);
    case "Grep": return `${String(i.pattern ?? "")} in ${String(i.path ?? ".")}`;
    case "WebSearch": return String(i.query ?? "").slice(0, 100);
    case "WebFetch": return String(i.url ?? "").slice(0, 100);
    default: return JSON.stringify(i).slice(0, 100);
  }
}

function extractSteps(ev: StreamEvent): string[] {
  if (ev.type !== "assistant" || !Array.isArray(ev.message?.content)) return [];
  const steps: string[] = [];
  for (const block of ev.message.content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      steps.push(`Claude: ${block.text.trim().replace(/\s+/g, " ").slice(0, 200)}`);
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      const detail = summarizeInput(block.name, block.input);
      steps.push(detail ? `→ ${block.name}: ${detail}` : `→ ${block.name}`);
    }
  }
  return steps;
}

// ── spawn (event-driven; supports both sync and background) ──────────────

interface BuildArgsOpts {
  prompt: string;
  sessionId: string;
  resume: boolean;
  model?: string;
  addDirs?: string[];
  permissionMode: string;
  toolsList: string;
  appendSystemPrompt?: string | null;
}

function buildArgs(opts: BuildArgsOpts): string[] {
  const args = [
    "-p",
    "--verbose", // required by --output-format stream-json when using -p
    "--output-format", "stream-json",
    "--permission-mode", opts.permissionMode,
    "--tools", opts.toolsList,
  ];
  if (opts.resume) args.push("--resume", opts.sessionId);
  else args.push("--session-id", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);
  args.push(opts.prompt);
  return args;
}

type SpawnImpl = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;

interface SpawnClaudeOpts {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  spawnImpl?: SpawnImpl;
  onStep: (step: string) => void;
  onDone: (result: RawClaudeResult) => void;
  onError: (err: Error) => void;
}

function spawnClaude(opts: SpawnClaudeOpts): ChildProcess | null {
  const sp = opts.spawnImpl ?? (spawn as unknown as SpawnImpl);
  const bin = claudeBin();
  let child: ChildProcess;
  try {
    child = sp(bin, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const hint = err.code === "ENOENT"
      ? `claude CLI not found at "${bin}". Install with: npm install -g @anthropic-ai/claude-code — or set JARELA_CLAUDE_BIN to the absolute path.`
      : `failed to spawn '${bin}': ${err.message}`;
    opts.onError(new Error(hint));
    return null;
  }

  let lineBuffer = "";
  let stdoutFallback = "";
  let finalResult: RawClaudeResult | null = null;
  let model: string | null = null;
  let killed = false;

  const timer: NodeJS.Timeout = setTimeout(() => {
    killed = true;
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
    const killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, 2_000);
    killTimer.unref();
  }, opts.timeoutMs);

  child.stdout?.on("data", (buf: Buffer) => {
    const chunk = buf.toString();
    stdoutFallback += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? ""; // keep incomplete last line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as StreamEvent;
        if (ev.type === "result") {
          finalResult = ev as RawClaudeResult;
        } else {
          if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string") model = ev.model;
          for (const s of extractSteps(ev)) opts.onStep(s);
        }
      } catch { /* non-JSON line, ignore */ }
    }
  });

  child.stderr?.on("data", () => { /* swallow — errors surface via exit code / result event */ });

  child.on("error", (e) => {
    clearTimeout(timer);
    const err = e as NodeJS.ErrnoException;
    const hint = err.code === "ENOENT"
      ? `claude CLI not found at "${bin}". Install: npm install -g @anthropic-ai/claude-code or set JARELA_CLAUDE_BIN.`
      : `claude spawn error: ${err.message}`;
    opts.onError(new Error(hint));
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    // flush any remaining partial line
    if (lineBuffer.trim()) {
      try {
        const ev = JSON.parse(lineBuffer) as StreamEvent;
        if (ev.type === "result") finalResult = ev as RawClaudeResult;
      } catch { /* trailing partial line — ignore */ }
    }
    if (killed) {
      opts.onError(new Error(`claude exceeded ${opts.timeoutMs / 1000}s timeout`));
      return;
    }
    if (!finalResult && code !== 0) {
      opts.onError(new Error(`claude exited ${code}: ${stdoutFallback.slice(-500)}`));
      return;
    }
    // Fallback: if no stream-json result line was found, try parsing the
    // full stdout as a single JSON blob (keeps test mocks simple).
    if (!finalResult) {
      try { finalResult = JSON.parse(stdoutFallback) as RawClaudeResult; }
      catch { finalResult = { result: stdoutFallback }; }
    }
    opts.onDone({ ...finalResult, _model: model ?? (finalResult._model as string | undefined) });
  });

  return child;
}

function runClaude(opts: Omit<SpawnClaudeOpts, "onStep" | "onDone" | "onError">): Promise<RawClaudeResult> {
  const steps: string[] = [];
  return new Promise((resolve, reject) => {
    spawnClaude({
      ...opts,
      onStep: (s) => steps.push(s),
      onDone: (result) => resolve({ ...result, _steps: steps }),
      onError: reject,
    });
  });
}

// ── memory sync + result shaping ───────────────────────────────────────────

type SyncMode = "in" | "out" | "both" | false;

function normalizeSyncMode(v: unknown): SyncMode {
  if (v === false) return false;
  if (v === "in" || v === "out" || v === "both") return v;
  return "both";
}

interface SyncReport {
  mode: "in" | "out" | "both";
  namespace: string;
  in?: { written: string[]; skipped: unknown[]; count: number } | { error: string };
  out?: { pushed: string[]; deleted: string[]; skipped: unknown[]; count: number } | { error: string };
}

interface FinalizeOpts {
  key: string;
  sessionId: string;
  resume: boolean;
  workspaceMissing: boolean;
  safetyMode: ReturnType<typeof resolveSafetyMode>;
  permissionMode: string;
  cwd: string;
  syncMode: SyncMode;
  syncManifest: Set<string> | null;
}

async function finalizeRun(raw: RawClaudeResult, opts: FinalizeOpts) {
  let syncReport: SyncReport | null = null;
  if (opts.syncMode === "out" || opts.syncMode === "both") {
    const namespace = bridge.namespaceForCwd(opts.cwd);
    syncReport = { mode: opts.syncMode, namespace };
    try {
      const r = bridge.syncOut(opts.cwd, namespace, opts.syncManifest ?? undefined);
      syncReport.out = { pushed: r.pushed, deleted: r.deleted, skipped: r.skipped, count: r.count };
    } catch (e) {
      syncReport.out = { error: (e as Error).message };
    }
  }

  rememberSession(opts.key, opts.sessionId);
  const changes = await gitDiffSummary(opts.cwd);

  const text = raw.result ?? "";
  const hasDesignQuestions = /(^|\n)##\s*Design questions\b/i.test(text);
  const permissionDenials = Array.isArray(raw.permission_denials) ? raw.permission_denials : [];

  return {
    result: text || null,
    project_key: opts.key,
    session_id: opts.sessionId,
    resumed: opts.resume,
    ...(opts.workspaceMissing ? { workspace_missing: true } : {}),
    awaiting_answers: hasDesignQuestions,
    steps: raw._steps ?? [],
    duration_ms: raw.duration_ms,
    cost_usd: raw.total_cost_usd,
    num_turns: raw.num_turns,
    model: raw._model,
    safety_mode: opts.safetyMode,
    permission_mode_used: opts.permissionMode,
    permission_denials: permissionDenials,
    ...(permissionDenials.length > 0 ? {
      verify_hint: "Claude's write/exec attempts were denied — see permission_denials. Pass allow_unsafe: true to let it actually make changes, or raise JARELA_TOOL_SAFETY.",
    } : {}),
    changes,
    ...(syncReport ? { sync: syncReport } : {}),
  };
}

// ── claude_delegate ────────────────────────────────────────────────────────

const permissionModeEnum = z.enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);

const delegateSchema = z.object({
  task: z.string().min(1).describe(
    "Task or follow-up message for the sub-agent. On the first call for a project the sub-agent has no parent-conversation context — be specific. On follow-ups, prior turns of THIS sub-agent are remembered, plus the project's own CLAUDE.md and accumulated auto-memory.",
  ),
  cwd: z.string().optional().describe(
    "Project directory. Defaults to the active workspace (call workspace_init first) or the process cwd. The session is keyed by this path — same cwd means same continuing session.",
  ),
  feature: z.string().optional().describe(
    "Optional sub-session label for working on multiple features in parallel within one project. Omit to use the project's default session.",
  ),
  model: z.string().optional().describe("Override model (e.g. 'sonnet', 'opus', 'haiku', or a full id). Defaults to the local CLI's configured default."),
  tools: z.string().optional().describe("Tool set: 'default' (all built-in, the default), '' (none), or a comma-separated list (e.g. 'Read,Grep,WebSearch')."),
  add_dirs: z.array(z.string()).optional().describe("Extra directories the sub-agent may access (--add-dir)."),
  permission_mode: permissionModeEnum.optional().describe(
    "Requested permission mode. Only honoured when JARELA_TOOL_SAFETY is 'bypass', or under 'mostly_safe' when allow_unsafe is true — otherwise it's forced to 'dontAsk' (read/explore only, every write/exec auto-denied).",
  ),
  allow_unsafe: z.boolean().optional().describe(
    "Under the default 'mostly_safe' safety tier, escalate this one call so the requested permission_mode (default 'bypassPermissions') is actually honoured, letting Claude write/exec. Ignored under 'safe' (always blocked) and 'bypass' (already unrestricted).",
  ),
  escalate_questions: z.boolean().optional().describe(
    "When true (default), the sub-agent is system-prompted to halt on ambiguous design decisions and surface them as a '## Design questions' block. Set false to have it plow through without asking.",
  ),
  fresh: z.boolean().optional().describe("Start a new session for this project/feature even if one exists."),
  background: z.boolean().optional().describe(
    "Spawn in the background and return a job_id immediately instead of waiting. Poll with claude_delegate_status.",
  ),
  timeout_seconds: z.number().optional().describe(`Max wall-clock time. Defaults to ${DEFAULT_TIMEOUT_S}.`),
  sync_memory: z.union([z.enum(["in", "out", "both"]), z.literal(false)]).optional().describe(
    "Sync between this project's own memory (namespace claude-sync:<hash of cwd>) and Claude's auto-memory dir. Defaults to 'both' — pull in before spawning, push Claude's learning back out after.",
  ),
});

export const claudeDelegateTool = tool(
  async (input, config?: ToolConfig) => {
    const {
      task, cwd: rawCwd, feature, model, tools, add_dirs,
      permission_mode, allow_unsafe, escalate_questions, fresh,
      background, timeout_seconds, sync_memory,
    } = input;

    const gate = resolveSafetyGate(permission_mode, allow_unsafe === true);
    if (gate.blocked) {
      return JSON.stringify({
        ok: false,
        code: "SAFETY_BLOCKED",
        error: "claude_delegate requires JARELA_TOOL_SAFETY to be at least 'mostly_safe' — spawning Claude Code grants it full read/write/exec access, which the 'safe' tier categorically disallows.",
        safety_mode: gate.safetyMode,
      });
    }

    const workspaceRoot = currentWorkspace(config)?.root;
    const claudeConfig = getClaudeCodeConfig();
    const { cwd, env } = resolveSubprocessEnv({ cwd: rawCwd, workspaceRoot, env: claudeConfig.env });
    const workspaceMissing = !rawCwd && !workspaceRoot;

    const key = projectKey(cwd, feature);
    const timeoutMs = (timeout_seconds ?? DEFAULT_TIMEOUT_S) * 1000;
    const toolsList = tools ?? "default";
    const appendSystemPrompt = escalate_questions === false ? null : DESIGN_QA_PROMPT;

    let sessionId: string;
    let resume = false;
    if (!fresh) {
      const prior = getSession(key);
      if (prior) { sessionId = prior; resume = true; }
      else sessionId = crypto.randomUUID();
    } else {
      sessionId = crypto.randomUUID();
    }

    const syncMode = normalizeSyncMode(sync_memory);
    let syncManifest: Set<string> | null = null;
    let preSyncReport: SyncReport | null = null;
    if (syncMode === "in" || syncMode === "both") {
      const namespace = bridge.namespaceForCwd(cwd);
      preSyncReport = { mode: syncMode, namespace };
      try {
        const r = bridge.syncIn(cwd, namespace);
        syncManifest = r.manifest;
        preSyncReport.in = { written: r.written, skipped: r.skipped, count: r.count };
      } catch (e) {
        preSyncReport.in = { error: (e as Error).message };
      }
    }

    const spawnArgs = buildArgs({
      prompt: task, sessionId, resume, model, addDirs: add_dirs,
      permissionMode: gate.permissionMode, toolsList, appendSystemPrompt,
    });

    if (background) {
      const jobId = crypto.randomUUID();
      const job = jobs.createJob(jobId, { projectKey: key, sessionId });
      const child = spawnClaude({
        args: spawnArgs, cwd, env, timeoutMs,
        onStep: (s) => jobs.appendStep(jobId, s),
        async onDone(raw) {
          try {
            const shaped = await finalizeRun(raw, {
              key, sessionId, resume, workspaceMissing,
              safetyMode: gate.safetyMode, permissionMode: gate.permissionMode,
              cwd, syncMode, syncManifest,
            });
            const withPreSync = preSyncReport
              ? { ...shaped, sync: { ...preSyncReport, ...shaped.sync } }
              : shaped;
            if (raw.is_error) jobs.failJob(jobId, `claude reported error: ${raw.result ?? ""}`);
            else jobs.completeJob(jobId, withPreSync);
          } catch (e) {
            jobs.failJob(jobId, (e as Error).message);
          }
        },
        onError(err) { jobs.failJob(jobId, err.message); },
      });
      if (child) job._child = child;

      return JSON.stringify({ job_id: jobId, status: "running", project_key: key, session_id: sessionId, resumed: resume });
    }

    const raw = await runClaude({ args: spawnArgs, cwd, env, timeoutMs });
    if (raw.is_error) {
      throw new Error(`claude reported error: ${raw.result ?? JSON.stringify(raw).slice(0, 500)}`);
    }
    const shaped = await finalizeRun(raw, {
      key, sessionId, resume, workspaceMissing,
      safetyMode: gate.safetyMode, permissionMode: gate.permissionMode,
      cwd, syncMode, syncManifest,
    });
    const withPreSync = preSyncReport ? { ...shaped, sync: { ...preSyncReport, ...shaped.sync } } : shaped;
    return JSON.stringify(withPreSync);
  },
  {
    name: "claude_delegate",
    description:
      "Delegate a feature-scoped coding task to a local Claude Code CLI process with full tool access (Read, Write, Edit, Bash, Skill, WebSearch, etc.), running inside the active workspace (call workspace_init first). " +
      "Sessions are keyed per project directory (and optional feature label) so the sub-agent accumulates long-term context across calls — its own CLAUDE.md and auto-memory load automatically. " +
      "Gated by JARELA_TOOL_SAFETY: under the default 'mostly_safe' tier, Claude can read/explore freely but every write/exec attempt is auto-denied (surfaced in permission_denials) unless you pass allow_unsafe: true; 'safe' refuses the call outright; 'bypass' honours whatever permission_mode you request. " +
      "Every call returns a git-diff summary in `changes` — after this call, inspect `changes` and read the modified files (or run tests/lint via local_exec) before reporting success to the user. Do not take Claude's own summary text on faith. " +
      "For long tasks, use background: true — returns a job_id immediately; poll with claude_delegate_status. When awaiting_answers is true, relay the '## Design questions' block to the user and call again with answers folded into the next task.",
    schema: delegateSchema,
  },
);

// ── claude_delegate_status ─────────────────────────────────────────────────

export const claudeDelegateStatusTool = tool(
  ({ job_id, last_step_index, action }: { job_id: string; last_step_index?: number; action?: "poll" | "cancel" }) => {
    if (action === "cancel") {
      const cancelled = jobs.cancelJob(job_id);
      if (!cancelled) throw new Error(`No running job with id ${job_id}`);
      return JSON.stringify({ job_id, status: "cancelled" });
    }

    const job = jobs.getJob(job_id);
    if (!job) throw new Error(`No job found with id ${job_id}`);

    const idx = Math.max(0, Math.floor(last_step_index ?? 0) || 0);
    const newSteps = job.steps.slice(idx);

    const out: Record<string, unknown> = {
      job_id,
      status: job.status,
      elapsed_ms: (job.finishedAt ?? Date.now()) - job.startedAt,
      steps: job.steps,
      new_steps: newSteps,
      next_step_index: job.steps.length,
    };
    if (job.status === "done") out.result = job.result;
    if (job.status === "error") out.error = job.error;
    return JSON.stringify(out);
  },
  {
    name: "claude_delegate_status",
    description:
      "Poll or cancel a background claude_delegate job. Returns the current status, all steps so far, and the slice of new steps since last_step_index — relay new_steps to the user on each poll to show real-time progress. When status is 'done', result contains the same shape as a synchronous claude_delegate call. Use action: 'cancel' to kill a running job.",
    schema: z.object({
      job_id: z.string().describe("Job ID returned by claude_delegate when called with background: true."),
      last_step_index: z.number().optional().describe("Index of the last step already seen. Pass next_step_index from the previous call. Defaults to 0."),
      action: z.enum(["poll", "cancel"]).optional().describe("Defaults to 'poll'. Use 'cancel' to kill a running job."),
    }),
  },
);

registerLangChainPackage({
  category: "Agent",
  tools: { execute: [claudeDelegateTool, claudeDelegateStatusTool] },
});

// Exposed for tests only — not part of the tool contract.
export const __testing = {
  buildArgs, spawnClaude, runClaude, extractSteps, summarizeInput,
  projectKey, finalizeRun, normalizeSyncMode,
};
