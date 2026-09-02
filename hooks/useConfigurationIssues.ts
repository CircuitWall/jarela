"use client";
import { useEffect, useRef } from "react";
import { api } from "@/api/client";
import { agentModelStatus } from "@/lib/agents/effective-model";
import { dismissToast, pushToast } from "@/lib/ui/toasts";

// Stable IDs for each kind of configuration issue we surface, scoped by
// the affected agent / model name so we can dedupe across refreshes and
// also dismiss when the issue is fixed without spamming on every reload.
type IssueId =
  | `no-models`
  | `no-default-model`
  | `agent-missing-model:${string}`
  | `agent-no-model:${string}`;

/**
 * Watches model/agent CRUD and surfaces configuration issues as sticky
 * top toasts with deep-links to the relevant setup panel. Without this
 * the only visible warnings were inline badges in the Scheduled Tasks
 * panel — operators using only the Chat surface had no clue an agent
 * was silently falling back to the default (or had no model at all).
 *
 * Dedupes via a tracked Map of issue → toast id; reconciles on every
 * refresh so resolved issues get auto-dismissed.
 */
export function useConfigurationIssues(): void {
  const activeRef = useRef<Map<IssueId, string>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      let models, agents;
      try {
        [models, agents] = await Promise.all([api.models.list({ force: true }), api.agents.list()]);
      } catch {
        return; // server unreachable — don't fight the offline banner
      }
      if (cancelled) return;

      const next = new Set<IssueId>();
      const pushIssue = (
        id: IssueId,
        kind: "error" | "info",
        title: string,
        body: string,
        href: string,
        hrefLabel: string,
      ) => {
        next.add(id);
        if (activeRef.current.has(id)) return; // already shown — keep stable
        const toastId = pushToast({
          kind,
          source: "system",
          sourceLabel: "Configuration",
          title,
          body,
          agent_id: null,
          thread_id: null,
          href,
          hrefLabel,
          ttl: 0, // sticky until fixed
        });
        activeRef.current.set(id, toastId);
      };

      if (models.length === 0) {
        pushIssue(
          "no-models",
          "error",
          "No model configured",
          "Agents can't run until at least one model config exists.",
          "?tab=models",
          "Open Models →",
        );
      } else if (!models.some((m) => m.is_default)) {
        pushIssue(
          "no-default-model",
          "info",
          "No default model set",
          "Agents without an explicit model will fail. Pick one default.",
          "?tab=models",
          "Open Models →",
        );
      }

      for (const a of agents) {
        const status = agentModelStatus(a, models);
        if (status.state === "no-model") {
          pushIssue(
            `agent-no-model:${a.id}`,
            "error",
            `Agent "${a.name}" has no model`,
            "Pick a model or set a workspace default.",
            `?tab=agents&item=${encodeURIComponent(a.id)}`,
            "Fix in Agents →",
          );
        }
      }

      // Dismiss any toast whose underlying issue no longer applies.
      for (const [id, toastId] of activeRef.current.entries()) {
        if (!next.has(id)) {
          dismissToast(toastId);
          activeRef.current.delete(id);
        }
      }
    }

    void refresh();
    const onChange = () => { void refresh(); };
    window.addEventListener("jarela:models-changed", onChange);
    window.addEventListener("jarela:agents-changed", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("jarela:models-changed", onChange);
      window.removeEventListener("jarela:agents-changed", onChange);
    };
  }, []);
}
