// Agent-callable knobs for the JARELA_* override store.
//
// Both tools are gated by the per-var schema flag `agentWritable` —
// agents cannot write to anything not flagged true (defaults to false).
// `restart_server` is only wired here; agents still need the tool to be
// in their selected toolset to call it (default agents do not include
// these).
//
// Use cases the user explicitly asked to support:
//   - "agent, lower the run idle timeout to 30s and restart"
//   - "agent, switch the log level to debug for the next hour"
//
// We surface the schema's tier/restart flags in the response so the
// agent's reply can tell the user what changed and whether a restart
// fired (or is needed but skipped).

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "../packages/langchain-package";
import { envSchemaByName } from "@/lib/env/schema";
import { patchOverride, validateForSchema } from "@/lib/env/overrides";
import { resetConfigCache } from "@/lib/env/config";
import { randomUUID } from "node:crypto";
import { recordThreadSignal } from "@/lib/lifecycle/system-signals";
import { restartOperationIdForThread } from "@/lib/stores/system-signals";

const setEnvSchema = z.object({
  name: z.string().describe("Env var name. Must be a JARELA_* knob the schema flags as agent-writable; otherwise the call returns code=forbidden."),
  value: z
    .string()
    .nullable()
    .describe("New value as a string (numbers/bools come as their string form: '5000' / 'true'). Pass null to clear the override and revert to the default."),
  reason: z
    .string()
    .optional()
    .describe("Short note explaining the change — logged for postmortems."),
});

const setEnvVar = tool(
  async ({ name, value, reason }, config) => {
    const def = envSchemaByName().get(name);
    if (!def) {
      return JSON.stringify({
        ok: false,
        code: "unknown_var",
        error: `unknown env var: ${name}`,
        hint: "List the schema with /api/v1/env (GET) before guessing names. Only JARELA_* keys defined in lib/env/schema.ts are accepted.",
      });
    }
    if (!def.agentWritable) {
      return JSON.stringify({
        ok: false,
        code: "forbidden",
        error: `${name} is not flagged agentWritable in the schema`,
        hint: "Agents cannot edit infra knobs (port, hostname, dataDir, …). Tell the user to change this from the Environment panel themselves.",
      });
    }
    if (value !== null) {
      const verr = validateForSchema(def, value);
      if (verr) {
        return JSON.stringify({
          ok: false,
          code: "invalid_value",
          error: `${name}: ${verr}`,
          hint: "Re-issue the call with a value that matches the schema's type/min/max/enum.",
        });
      }
    }
    await patchOverride(name, value);
    if (value === null) delete process.env[name];
    else process.env[name] = value;
    resetConfigCache();
    try {
      recordThreadSignal(config?.configurable?.thread_id,
        def.requiresRestart ? "configuration.restart_required" : "configuration.applied",
        randomUUID(), { name, requires_restart: def.requiresRestart });
    } catch (error) { console.error("[system-signals] configuration outcome publication failed", error); }
    return JSON.stringify({
      ok: true,
      name,
      value,
      requiresRestart: def.requiresRestart,
      reason: reason ?? null,
      hint: def.requiresRestart
        ? "Override persisted. Applying it requires restarting the live Jarela instance hosting your current turn and other agents. This interrupts active runs. Do not call restart_server without the user's explicit approval of that interruption; otherwise tell the user to click Restart in the Environment panel when ready."
        : "Override persisted and is in effect immediately. No restart needed.",
    });
  },
  {
    name: "set_env_var",
    description:
      "Set or unset a JARELA_* runtime override on the live Jarela instance hosting this agent. Only schema-flagged agent-writable knobs are accepted; everything else returns code=forbidden. Use this when the user explicitly asks to change a runtime setting (e.g. log level, retry budget), not to investigate source code. A requiresRestart=true result is not restart approval: explain that active runs will be interrupted and obtain explicit user approval before calling restart_server.",
    schema: setEnvSchema,
  },
);

const restartSchema = z.object({
  reason: z.string().min(1).describe("Why the restart is needed (logged + included in /api/v1/system/restart payload). Required."),
});

const restartServer = tool(
  async ({ reason }, config) => {
    if (config?.configurable?.signal_continuation === true) {
      return JSON.stringify({
        ok: false, code: "restart_not_authorized",
        hint: "This is an automated completion turn, not a new restart request. The earlier restart is complete. Do not restart through another tool or command; report the completion receipt and stop.",
      });
    }
    const threadId = config?.configurable?.thread_id;
    const operationId = restartOperationIdForThread(threadId);
    if (!operationId) {
      return JSON.stringify({ ok: false, code: "restart_not_authorized",
        hint: "Restart requires a persisted direct user request in this thread. No request was found; do not restart or attempt another route." });
    }
    // Use the same endpoint the UI hits. Doing it via fetch instead of
    // calling process.exit() directly here means the request response
    // flushes back to the agent (and through it, the user) before the
    // process tears down.
    try {
      const port = Number(process.env.JARELA_PORT ?? process.env.PORT ?? 4312);
      const host = process.env.JARELA_HOSTNAME ?? process.env.HOSTNAME ?? "127.0.0.1";
      const r = await fetch(`http://${host}:${port}/api/v1/system/restart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: `[agent] ${reason}`, thread_id: threadId, operation_id: operationId }),
      });
      const body = (await r.json().catch(() => ({}))) as { hint?: string };
      return JSON.stringify({
        ok: r.ok,
        status: r.status,
        reason,
        hint: body.hint ?? (r.ok
          ? "Restart request sent to the live Jarela instance hosting your current turn. Active runs may be interrupted and are not guaranteed to resume. A completion signal arrives on your next turn after an unlocked new instance initializes. Do not send another restart request."
          : "Restart request was rejected. Do not claim that the restart happened or repeat it automatically; inspect the failure first."),
      });
    } catch (e) {
      return JSON.stringify({
        ok: false,
        code: "restart_failed",
        error: (e as Error).message,
        hint: "Could not confirm the restart request. Its outcome may be unknown; check the runtime and completion signals before trying again. Do not automatically repeat the restart.",
      });
    }
  },
  {
    name: "restart_server",
    description:
      "Restart the live Jarela instance hosting this agent, interrupting your current turn and other active runs. Only call this when the user explicitly approves that interruption. A request to inspect, debug, build, or test source code, or a set_env_var result with requiresRestart=true, is not restart approval. Do not restart for provider rate limits, unavailable models, or tool errors. Send at most one restart request; interrupted work is not guaranteed to resume even if the UI reconnects.",
    schema: restartSchema,
  },
);

registerLangChainPackage({
  category: "Config",
  tools: { execute: [setEnvVar, restartServer] },
});
