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
import { registerTools } from "./registry";
import { envSchemaByName } from "@/lib/env/schema";
import { patchOverride, validateForSchema } from "@/lib/env/overrides";
import { resetConfigCache } from "@/lib/env/config";

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
  async ({ name, value, reason }) => {
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
    return JSON.stringify({
      ok: true,
      name,
      value,
      requiresRestart: def.requiresRestart,
      reason: reason ?? null,
      hint: def.requiresRestart
        ? "Override persisted. The change requires a server restart — call restart_server to apply, OR tell the user to click Restart in the Environment panel."
        : "Override persisted and is in effect immediately. No restart needed.",
    });
  },
  {
    name: "set_env_var",
    description:
      "Set or unset a JARELA_* runtime override. Only schema-flagged agent-writable knobs are accepted; everything else returns code=forbidden. Use this when the user explicitly asks to change a runtime setting (e.g. log level, retry budget). Pair with restart_server when the result reports requiresRestart=true.",
    schema: setEnvSchema,
  },
);

const restartSchema = z.object({
  reason: z.string().min(1).describe("Why the restart is needed (logged + included in /api/v1/system/restart payload). Required."),
});

const restartServer = tool(
  async ({ reason }) => {
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
        body: JSON.stringify({ reason: `[agent] ${reason}` }),
      });
      const body = (await r.json().catch(() => ({}))) as { hint?: string };
      return JSON.stringify({
        ok: r.ok,
        status: r.status,
        reason,
        hint: body.hint ?? "Restart request sent. The supervisor will relaunch the process; the user's UI will reconnect automatically.",
      });
    } catch (e) {
      return JSON.stringify({
        ok: false,
        code: "restart_failed",
        error: (e as Error).message,
        hint: "Could not reach /api/v1/system/restart from inside the same process. Tell the user they need to restart manually.",
      });
    }
  },
  {
    name: "restart_server",
    description:
      "Restart the Jarela server. Only call this when the user explicitly asks for a restart, OR when set_env_var returned requiresRestart=true and the user agreed. The UI reconnects automatically once the supervisor (launchd/systemd/Task Scheduler) relaunches.",
    schema: restartSchema,
  },
);

registerTools("Config", "execute", [setEnvVar, restartServer]);
