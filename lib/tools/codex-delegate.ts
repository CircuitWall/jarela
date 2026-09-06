import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { gitDiffSummary } from "./git-probe";
import { registerLangChainPackage } from "./langchain-package";
import { resolveSafetyMode } from "./safety";
import { resolveSubprocessEnv } from "./subprocess-env";
import { withStreamDefault } from "./tool-metadata";
import { currentWorkspace, reportToolProgress, type ToolConfig } from "./workspace-context";

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

export function getCodexConfig() {
  const saved = getIntegrationRaw(INTEGRATION_ID);
  const apiKey = clean(saved?.api_key) ?? clean(process.env.CODEX_API_KEY);
  return {
    bin: clean(saved?.cli_path) ?? clean(process.env.JARELA_CODEX_BIN) ?? "codex",
    model: clean(saved?.default_model) ?? clean(process.env.JARELA_CODEX_DEFAULT_MODEL),
    timeoutSeconds: timeoutFrom(saved?.default_timeout_seconds) ?? timeoutFrom(process.env.JARELA_CODEX_DEFAULT_TIMEOUT_SECONDS) ?? DEFAULT_TIMEOUT_SECONDS,
    env: apiKey ? { CODEX_API_KEY: apiKey } : {} as Record<string, string>,
  };
}

export function resolveCodexLaunch(bin: string, args: string[], appData = process.env.APPDATA): { command: string; args: string[] } {
  // npm's Windows `codex` command is a .cmd wrapper, which Node cannot
  // execute without a shell. Launch its JavaScript entrypoint via Node so
  // model-provided task text stays isolated in an argument array.
  if (platform() === "win32" && bin === "codex" && appData) {
    const entrypoint = path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(entrypoint)) return { command: process.execPath, args: [entrypoint, ...args] };
  }
  return { command: bin, args };
}

export function buildCodexArgs(task: string, model: string | undefined, allowUnsafe: boolean): string[] {
  const args = ["exec", "--json", "--sandbox", allowUnsafe ? "workspace-write" : "read-only"];
  if (model) args.push("--model", model);
  args.push(task);
  return args;
}

function collectCodexOutput(child: ChildProcess, timeoutMs: number, onProgress: (step: string) => void): Promise<{ result: string; threadId?: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    let finalMessage = "";
    let threadId: string | undefined;
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
          const event = JSON.parse(line) as { type?: string; thread_id?: string; item?: { type?: string; text?: string; command?: string } };
          if (event.type === "thread.started") threadId = event.thread_id;
          if (event.item?.type === "agent_message" && event.item.text) finalMessage = event.item.text;
          if (event.item?.type === "command_execution" && event.item.command) onProgress(`Codex: ${event.item.command.slice(0, 200)}`);
        } catch { /* Codex documented JSONL output; ignore malformed diagnostic lines. */ }
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new Error("codex CLI not found. Install with: npm install -g @openai/codex, then run: codex login") : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`codex exited ${code}`));
      resolve({ result: finalMessage || output.trim(), threadId });
    });
  });
}

export const codexDelegateTool = withStreamDefault(tool(
  async ({ task, cwd: requestedCwd, model, allow_unsafe, timeout_seconds }, config?: ToolConfig) => {
    const safetyMode = resolveSafetyMode();
    if (safetyMode === "safe") {
      return JSON.stringify({ ok: false, code: "SAFETY_BLOCKED", error: "codex_delegate requires JARELA_TOOL_SAFETY to be at least 'mostly_safe'.", safety_mode: safetyMode });
    }
    const codex = getCodexConfig();
    const allowUnsafe = allow_unsafe === true || safetyMode === "bypass";
    const { cwd, env } = resolveSubprocessEnv({ cwd: requestedCwd, workspaceRoot: currentWorkspace(config)?.root, env: codex.env });
    const args = buildCodexArgs(task, model ?? codex.model, allowUnsafe);
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
      model: model ?? codex.model ?? null,
      sandbox: allowUnsafe ? "workspace-write" : "read-only",
      safety_mode: safetyMode,
      changes: await gitDiffSummary(cwd),
    });
  },
  {
    name: "codex_delegate",
    description:
      "Delegate a focused coding task to the locally installed OpenAI Codex CLI in the active workspace. Codex reuses its local ChatGPT sign-in by default; an optional saved API key is used only for trusted automation. Under JARELA_TOOL_SAFETY=mostly_safe, Codex starts read-only unless allow_unsafe is true, which grants workspace-write access. Returns Codex's final message and a git diff summary; inspect the changes before reporting success.",
    schema: z.object({
      task: z.string().min(1).describe("Self-contained coding task for Codex."),
      cwd: z.string().optional().describe("Workspace directory; defaults to Jarela's active workspace."),
      model: z.string().optional().describe("Optional Codex model override."),
      allow_unsafe: z.boolean().optional().describe("Grant Codex workspace-write access for this trusted task under mostly_safe mode."),
      timeout_seconds: z.number().positive().optional().describe("Idle timeout in seconds."),
    }),
  },
), true);

registerLangChainPackage({ category: "Other", integrationId: INTEGRATION_ID, tools: { execute: [codexDelegateTool] } });