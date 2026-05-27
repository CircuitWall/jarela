// Shared response shape for scheduled-task routes. Lives in `_response.ts`
// (underscore prefix) so Next's router treats it as a co-located helper
// instead of a route. Export-from-route.ts breaks the App Router type
// guard that only allows known HTTP-method exports.
import type { ScheduledTaskRow } from "@/lib/stores/scheduled-tasks";

export function rowResponse(r: ScheduledTaskRow) {
  let scriptArgs: unknown = null;
  if (r.reaction_script_args) {
    try { scriptArgs = JSON.parse(r.reaction_script_args); }
    catch { scriptArgs = null; }
  }
  return {
    id: r.id,
    agent_id: r.agent_id,
    prompt: r.prompt,
    description: r.description,
    kind: r.kind,
    schedule: r.schedule,
    next_run_at: r.next_run_at,
    last_run_at: r.last_run_at,
    last_error: r.last_error,
    enabled: r.enabled === 1,
    silent: r.silent === 1,
    reaction_kind: r.reaction_kind,
    reaction_script: r.reaction_script,
    reaction_script_args: scriptArgs,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
