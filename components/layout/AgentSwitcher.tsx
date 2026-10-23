"use client";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { AgentInfo } from "@/api/types";
import { Logo } from "@/components/ui/Logo";
import { getAppName } from "@/lib/env/app-config";
import { useUnreadByAgent } from "@/lib/ui/toasts";

interface Props {
  agents: Pick<AgentInfo, "id" | "name" | "icon">[];
  activeAgentId: string | null;
  loading?: boolean;
  onSelect: (agentId: string) => void;
}

const FADE_CLASSES = ["opacity-65", "opacity-50", "opacity-40", "opacity-30"];

export function AgentSwitcher({ agents, activeAgentId, loading = false, onSelect }: Props) {
  const unread = useUnreadByAgent();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const positions = useRef(new Map<string, DOMRect>());
  const animations = useRef<Animation[]>([]);
  const viewport = useRef<HTMLDivElement>(null);
  // Preserve the API's default/latest-message order; only promote the active agent.
  const orderedAgents = useMemo(() => {
    const activeIndex = agents.findIndex((agent) => agent.id === activeAgentId);
    if (activeIndex <= 0) return agents;
    return [agents[activeIndex], ...agents.slice(0, activeIndex), ...agents.slice(activeIndex + 1)];
  }, [agents, activeAgentId]);
  const activeAgent = orderedAgents[0]?.id === activeAgentId ? orderedAgents[0] : undefined;

  useLayoutEffect(() => {
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    const next = new Map<string, DOMRect>();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (viewport.current && activeAgent) viewport.current.scrollLeft = 0;
    for (const agent of orderedAgents) {
      const button = buttons.current.get(agent.id);
      if (!button) continue;
      const rect = button.getBoundingClientRect();
      next.set(agent.id, rect);
      const previous = positions.current.get(agent.id);
      if (!previous || reducedMotion || typeof button.animate !== "function") continue;
      const x = previous.left - rect.left;
      const y = previous.top - rect.top;
      if (x === 0 && y === 0 && previous.width === rect.width) continue;
      const selected = agent.id === activeAgentId;
      animations.current.push(button.animate([
        { transform: `translate(${x}px, ${y}px) scale(${selected ? 0.92 : 1})` },
        { transform: `translate(0px, 0px) scale(${selected ? 1.04 : 1})`, offset: 0.75 },
        { transform: "translate(0px, 0px) scale(1)" },
      ], {
        duration: selected ? 420 : 340,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      }));
    }
    positions.current = next;
    return () => { for (const animation of animations.current) animation.cancel(); };
  }, [orderedAgents, activeAgent, activeAgentId]);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {!activeAgent && (
        <span className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-fg">
          <Logo className="h-6 w-auto" />
          {agents.length === 0 && <span>{getAppName()}</span>}
        </span>
      )}
      <div ref={viewport} role="group" aria-label="Switch agent" aria-busy={loading}
        className="no-scrollbar min-w-0 overflow-x-auto py-1">
        <div className="flex w-max items-center gap-1 px-1">
          {orderedAgents.map((agent, index) => {
            const selected = agent.id === activeAgentId;
            const unreadCount = unread.get(agent.id) ?? 0;
            const unreadLabel = unreadCount > 0 ? `, ${unreadCount} unread ${unreadCount === 1 ? "notification" : "notifications"}` : "";
            const fade = FADE_CLASSES[Math.min(Math.max(0, activeAgent ? index - 1 : index), FADE_CLASSES.length - 1)];
            return (
              <button
                key={agent.id}
                ref={(node) => {
                  if (node) buttons.current.set(agent.id, node);
                  else buttons.current.delete(agent.id);
                }}
                type="button"
                aria-label={`${selected ? "Current agent" : "Switch to"}: ${agent.name}${unreadLabel}`}
                aria-pressed={selected}
                title={`${selected ? `${agent.name} (current agent)` : `Switch to ${agent.name}`}${unreadLabel}`}
                onClick={() => {
                  for (const [id, button] of buttons.current) positions.current.set(id, button.getBoundingClientRect());
                  onSelect(agent.id);
                }}
                className={`control-tap group relative inline-flex h-9 shrink-0 items-center rounded-xl px-1.5 outline-offset-2 transition-[background-color,box-shadow] duration-200 focus-visible:outline-2 focus-visible:outline-accent ${
                  selected
                    ? "z-10 bg-surface-3/70 text-fg ring-1 ring-accent/30"
                    : "text-fg-muted hover:bg-surface-3/60"
                }`}
              >
                <span className={`inline-flex items-center gap-2 transition-opacity duration-200 ${
                  selected ? "" : `${fade} group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100`
                }`}>
                {agent.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={agent.icon} alt="" className="h-6 w-6 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span aria-hidden className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${
                    selected ? "bg-accent/15 text-accent" : "bg-surface-3 text-fg-subtle"
                  }`}>
                    {agent.name.charAt(0).toUpperCase()}
                  </span>
                )}
                {selected && <span className="max-w-[7rem] truncate pr-1 text-sm font-semibold tracking-tight sm:max-w-[12rem]">{agent.name}</span>}
                </span>
                {unreadCount > 0 && (
                  <span aria-hidden="true" data-unread-dot
                    className="pointer-events-none absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-surface-2" />
                )}
              </button>
            );
          })}
        </div>
      </div>
      {loading && agents.length === 0 && <span role="status" className="sr-only">Loading agents</span>}
    </div>
  );
}
