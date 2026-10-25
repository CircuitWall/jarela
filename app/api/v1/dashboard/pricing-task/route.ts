import { NextResponse } from "next/server";
import { getAgentConfig, getDefaultAgentConfig } from "@/lib/stores/agent-configs";
import { createScheduledTask, getScheduledTask, updateScheduledTask } from "@/lib/stores/scheduled-tasks";
import { startScheduler } from "@/lib/scheduler";
import {
  WEEKLY_PRICING_TASK_CRON,
  WEEKLY_PRICING_TASK_DESCRIPTION,
  WEEKLY_PRICING_TASK_ID,
  WEEKLY_PRICING_TASK_PROMPT,
  weeklyPricingTaskUpgrade,
} from "@/lib/pricing/maintenance-task";

export const dynamic = "force-dynamic";

function statusResponse() {
  const defaultAgent = getDefaultAgentConfig();
  const task = getScheduledTask(WEEKLY_PRICING_TASK_ID);
  const taskAgent = task ? getAgentConfig(task.agent_id) : null;
  return NextResponse.json({
    configured: !!task && !!taskAgent,
    default_agent_configured: !!defaultAgent,
    default_agent_name: defaultAgent?.name ?? null,
    task_agent_name: taskAgent?.name ?? null,
    next_run_at: task?.next_run_at ?? null,
    enabled: task?.enabled === 1 && !!taskAgent,
    schedule: task?.schedule ?? null,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  });
}

export function GET() {
  return statusResponse();
}

export async function POST() {
  const defaultAgent = getDefaultAgentConfig();
  if (!defaultAgent) {
    return NextResponse.json({ error: "Configure a default agent before setting up weekly pricing updates." }, { status: 409 });
  }

  let task = getScheduledTask(WEEKLY_PRICING_TASK_ID);
  if (!task) {
    try {
      task = createScheduledTask({
        id: WEEKLY_PRICING_TASK_ID,
        agent_id: defaultAgent.id,
        prompt: WEEKLY_PRICING_TASK_PROMPT,
        description: WEEKLY_PRICING_TASK_DESCRIPTION,
        kind: "cron",
        schedule: WEEKLY_PRICING_TASK_CRON,
        silent: true,
      });
    } catch (err) {
      task = getScheduledTask(WEEKLY_PRICING_TASK_ID);
      if (!task) throw err;
    }
  } else if (task.enabled !== 1 || task.agent_id !== defaultAgent.id || weeklyPricingTaskUpgrade(task)) {
    task = updateScheduledTask(WEEKLY_PRICING_TASK_ID, {
      ...weeklyPricingTaskUpgrade(task),
      agent_id: defaultAgent.id,
      enabled: true,
    }) ?? task;
  }
  startScheduler();
  return statusResponse();
}