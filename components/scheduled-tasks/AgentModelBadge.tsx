"use client";
import { AlertTriangle } from "lucide-react";
import type { AgentModelStatus } from "@/lib/agents/effective-model";
import { Badge } from "@/components/ui/Badge";

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
  } else {
    label = "no model";
    tooltip =
      "Agent has no model assigned and no workspace default is set. Runs will fail with no_model — open the Models panel and add or default a model.";
  }

  return (
    <Badge tone="warning" size="sm" bordered title={tooltip} icon={<AlertTriangle size={10} />}>
      {label}
    </Badge>
  );
}
