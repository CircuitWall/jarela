import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { gitDiffSummary } from "../support/git-probe";
import { registerLangChainPackage } from "../packages/langchain-package";
import { resolveSafetyMode } from "../security/safety";
import { resolveSubprocessEnv } from "../security/subprocess-env";
import { withStreamDefault } from "../support/tool-metadata";
import { currentWorkspace, reportToolProgress, type ToolConfig } from "../filesystem/workspace-context";

const INTEGRATION_ID = "openai-codex";
const DEFAULT_TIMEOUT_SECONDS = 600;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function timeoutFrom(value: string | undefined): number | undefined {
  const parsed = Number(clean(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function listFrom(value: string | undefined): string[] | undefined {
  const normalized = clean(value);
  if (!normalized) return undefined;
  const entries = normalized.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

export function getCodexConfig() {
  const saved = getIntegrationRaw(INTEGRATION_ID);
  const apiKey = clean(saved?.api_key) ?? clean(process.env.CODEX_API_KEY);
  return {
    bin: clean(saved?.cli_path) ?? clean(process.env.JARELA_CODEX_BIN) ?? "codex",
    model: clean(saved?.default_model) ?? clean(process.env.JARELA_CODEX_DEFAULT_MODEL),
    profile: clean(saved?.default_profile) ?? clean(process.env.JARELA_CODEX_DEFAULT_PROFILE),
    addDirs: listFrom(clean(saved?.default_add_dirs) ?? clean(process.env.JARELA_CODEX_DEFAULT_ADD_DIRS)),
    timeoutSeconds: timeoutFrom(saved?.default_timeout_seconds) ?? timeoutFrom(process.env.JARELA_CODEX_DEFAULT_TIMEOUT_SECONDS) ?? DEFAULT_TIMEOUT_SECONDS,
    env: apiKey ? { CODEX_API_KEY: apiKey } : {} as Record<string, string>,
  };
}

export function resolveCodexLaunch(bin: string, args: string[], appData = process.env.APPDATA): { command: string; args: string[] } {
  // npm's Windows `codex` command is a .cmd wrapper, which Node cannot
  // execute without a shell. Launch its JavaScript entrypoint via Node so
  // model-provided task text stays isolated in an argument array.
  if (platform() === "win32") {
    const entrypoint = bin === "codex" && appData
      ? path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      : /codex\.(?:cmd|ps1)$/i.test(bin)
        ? path.join(path.dirname(bin), "node_modules", "@openai", "codex", "bin", "codex.js")
        : "";
    if (existsSync(entrypoint)) return { command: process.execPath, args: [entrypoint, ...args] };
  }
  return { command: bin, args };
}

export function buildCodexArgs(task: string, model: string | undefined, profile: string | undefined, addDirs: string[] | undefined, allowUnsafe: boolean): string[] {
  const args = ["exec", "--json", "--sandbox", allowUnsafe ? "workspace-write" : "read-only"];
  if (model) args.push("--model", model);
  if (profile) args.push("--profile", profile);
  for (const directory of addDirs ?? []) args.push("--add-dir", directory);
  args.push(task);
  return args;
}

export function resolveCodexWorkspace(requestedCwd: string | undefined, workspaceRoot: string | undefined): string | null {
  return requestedCwd?.trim() || workspaceRoot?.trim() || null;
}

function cappedDiagnostic(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

function eventDiagnostic(event: { error?: unknown; message?: unknown }): string {
  if (typeof event.error === "string") return cappedDiagnostic(event.error);
  if (typeof event.message === "string") return cappedDiagnostic(event.message);
  return "";
}

function collectCodexOutput(child: ChildProcess, timeoutMs: number, onProgress: (step: string) => void): Promise<{ result: string; threadId?: string; steps: string[] }> {
  return new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    let terminalDiagnostic = "";
    let finalMessage = "";
    let threadId: string | undefined;
    const steps: string[] = [];
    let timer: NodeJS.Timeout;
    const onTimeout = () => {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      reject(new Error(`codex exceeded ${timeoutMs / 1000}s timeout`));
    };
    const rearm = () => { clearTimeout(timer); timer = setTimeout(onTimeout, timeoutMs); };
    timer = setTimeout(onTimeout, timeoutMs);

    child.stdout?.on("data", (buffer: Buffer) => {
      rearm();
      output += buffer.toString();
      const lines = output.split(/\r?\n/);
      output = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { type?: string; thread_id?: string; error?: unknown; message?: unknown; item?: { type?: string; text?: string; command?: string } };
          if (event.type === "thread.started") threadId = event.thread_id;
          if (event.type === "error" || event.type === "turn.failed") terminalDiagnostic = eventDiagnostic(event);
          if (event.item?.type === "agent_message" && event.item.text) {
            finalMessage = event.item.text;
            steps.push(`Codex: ${event.item.text.replace(/\s+/g, " ").trim().slice(0, 400)}`);
          }
          if (event.item?.type === "command_execution" && event.item.command) {
            const step = `→ ${event.item.command.slice(0, 200)}`;
            steps.push(step);
            onProgress(step);
          }
        } catch { /* Codex documented JSONL output; ignore malformed diagnostic lines. */ }
      }
    });
    child.stderr?.on("data", (buffer: Buffer) => { rearm(); stderr += buffer.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new Error("codex CLI not found. Install with: npm install -g @openai/codex, then run: codex login") : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const diagnostic = terminalDiagnostic || cappedDiagnostic(stderr) || cappedDiagnostic(output);
        return reject(new Error(`codex exited ${code}${diagnostic ? `: ${diagnostic}` : ""}`));
      }
      resolve({ result: finalMessage || output.trim(), threadId, steps });
    });
  });
}

export const codexDelegateTool = withStreamDefault(tool(
  async ({ task, cwd: requestedCwd, model, profile, add_dirs, allow_unsafe, timeout_seconds }, config?: ToolConfig) => {
    const safetyMode = resolveSafetyMode();
    if (safetyMode === "safe") {
      return JSON.stringify({ ok: false, code: "SAFETY_BLOCKED", error: "codex_delegate requires JARELA_TOOL_SAFETY to be at least 'mostly_safe'.", safety_mode: safetyMode });
    }
    const codex = getCodexConfig();
    const allowUnsafe = allow_unsafe === true || safetyMode === "bypass";
    const workspaceRoot = currentWorkspace(config)?.root;
    const requestedWorkspace = resolveCodexWorkspace(requestedCwd, workspaceRoot);
    if (!requestedWorkspace) {
      return JSON.stringify({
        ok: false,
        code: "WORKSPACE_REQUIRED",
        error: "Codex requires a project workspace. Call workspace_init with the repository path before delegating, or pass cwd explicitly.",
      });
    }
    const { cwd, env } = resolveSubprocessEnv({ cwd: requestedWorkspace, workspaceRoot, env: codex.env });
    const resolvedModel = model ?? codex.model;
    const resolvedProfile = profile ?? codex.profile;
    const resolvedAddDirs = add_dirs ?? codex.addDirs;
    const args = buildCodexArgs(task, resolvedModel, resolvedProfile, resolvedAddDirs, allowUnsafe);
    const launch = resolveCodexLaunch(codex.bin, args);
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      throw new Error(`failed to spawn codex: ${(error as Error).message}`);
    }
    const completed = await collectCodexOutput(child, (timeout_seconds ?? codex.timeoutSeconds) * 1000, (step) => reportToolProgress(config, "codex_delegate", step));
    return JSON.stringify({
      ok: true,
      result: completed.result || null,
      thread_id: completed.threadId,
      cwd,
      model: resolvedModel ?? null,
      profile: resolvedProfile ?? null,
      add_dirs: resolvedAddDirs ?? [],
      sandbox: allowUnsafe ? "workspace-write" : "read-only",
      safety_mode: safetyMode,
      transcript: {
        provider: "Codex",
        parent_message: task,
        steps: completed.steps,
      },
      changes: await gitDiffSummary(cwd),
    });
  },
  {
    name: "codex_delegate",
    description:
      "Delegate a focused coding task to the locally installed OpenAI Codex CLI. Call workspace_init with the target repository before this tool, or pass cwd explicitly; do not use Jarela's install directory as the project workspace. Codex loads its normal user and project configuration, so enabled Codex plugins, skills, MCP servers, and hooks are available to the delegated run under Codex's own approval policies. Codex reuses its local ChatGPT sign-in by default; an optional saved API key is used only for trusted automation. Under JARELA_TOOL_SAFETY=mostly_safe, Codex starts read-only unless allow_unsafe is true, which grants workspace-write access. Use profile only for a pre-existing trusted Codex profile and add_dirs only when the task needs additional writable directories. Returns Codex's final message and a git diff summary; inspect the changes before reporting success.",
    schema: z.object({
      task: z.string().min(1).describe("Self-contained coding task for Codex."),
      cwd: z.string().optional().describe("Target repository directory. Defaults to the active workspace; call workspace_init first when omitted."),
      model: z.string().optional().describe("Optional Codex model override."),
      profile: z.string().optional().describe("Optional pre-existing Codex configuration profile."),
      add_dirs: z.array(z.string()).optional().describe("Additional directories Codex may write alongside the workspace."),
      allow_unsafe: z.boolean().optional().describe("Grant Codex workspace-write access for this trusted task under mostly_safe mode."),
      timeout_seconds: z.number().positive().optional().describe("Idle timeout in seconds."),
    }),
  },
), true);

registerLangChainPackage({ category: "Other", integrationId: INTEGRATION_ID, tools: { execute: [codexDelegateTool] } });