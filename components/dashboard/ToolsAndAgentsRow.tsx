"use client";
import type { DashboardCurrencyInfo, DashboardMetrics } from "@/api/types";
import { sortTools, type ToolSort } from "@/lib/dashboard/sort";
import { AgentCostPie } from "./Donuts";
import { TOOL_SORT_OPTIONS } from "./dashboard-constants";

interface ToolsAndAgentsRowProps {
  data: DashboardMetrics;
  toolSort: ToolSort;
  onToolSortChange: (sort: ToolSort) => void;
  effectiveTopAgents: DashboardMetrics["top_agents"];
  selectedDay: string | null;
  currencyInfo: DashboardCurrencyInfo;
}

export function ToolsAndAgentsRow({ data, toolSort, onToolSortChange, effectiveTopAgents, selectedDay, currencyInfo }: ToolsAndAgentsRowProps) {
  const sortedTools = sortTools(data.top_tools, toolSort);
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">Favorite tools</h3>
          <select
            value={toolSort}
            onChange={(e) => onToolSortChange(e.target.value as ToolSort)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
            style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-primary)" }}
          >
            {TOOL_SORT_OPTIONS.map((opt) => (
              <option
                key={opt.value}
                value={opt.value}
                style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-secondary)" }}
              >
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          {sortedTools.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)]">No tool calls recorded yet.</p>
          ) : (
            sortedTools.map((tool) => (
              <div key={tool.name} className="rounded-lg bg-[var(--bg-primary)]/35 px-3 py-2">
                <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-[var(--text-primary)]">{tool.name}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                      score {tool.score.toFixed(2)} · {(tool.success_rate * 100).toFixed(1)}% success · {tool.call_count} calls · {tool.error_count} errors
                    </div>
                  </div>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    tool.score >= 0.85
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : tool.score >= 0.65
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                  }`}>
                    {tool.score >= 0.85 ? "keep" : tool.score >= 0.65 ? "review" : "consider disable"}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 shadow-sm">
        <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">
          Agent cost hotspots
          {selectedDay ? <span className="ml-2 text-[11px] text-[var(--text-secondary)]">on {selectedDay}</span> : null}
        </h3>
        <AgentCostPie
          key={`agents-${selectedDay ?? "all"}`}
          agents={effectiveTopAgents.slice(0, 6)}
          currencyInfo={currencyInfo}
        />
      </section>
    </div>
  );
}
