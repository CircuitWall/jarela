"use client";
import { AlertTriangle } from "lucide-react";
import type { AgentModelStatus } from "@/lib/agents/effective-model";

// Inline warning badge for scheduled-task and watcher cards. Renders nothing
// when the agent's model resolves cleanly so the row stays uncluttered; only
// surfaces when a future run would `no_model` or silently substitute the
// workspace default. Both cases are easy to miss for unattended runs.
export function AgentModelBadge({ status }: { status: AgentModelStatus }) {
  if (status.state === "ok") return null;

  let label: string;
  let tooltip: string;
  if (status.state === "no-agent") {
    label = "agent missing";
    tooltip = "The agent for this task was deleted. It will fail on the next run.";
  } else if (status.state === "no-model") {
    label = "no model";
    tooltip =
      "Agent has no model assigned and no workspace default is set. Runs will fail with no_model — open the Models panel and add or default a model.";
  } else if (status.fallback) {
    label = `model "${status.requested}" missing`;
    tooltip = `Configured model "${status.requested}" no longer exists; runs will silently fall back to the default model "${status.fallback.name}". Reassign the agent to a present model.`;
  } else {
    label = `model "${status.requested}" missing`;
    tooltip = `Configured model "${status.requested}" no longer exists and there is no workspace default. Runs will fail with no_model.`;
  }

  return (
    <span
      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30"
      title={tooltip}
    >
      <AlertTriangle size={10} />
      {label}
    </span>
  );
}
