"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig } from "@/api/types";
import { useUnreadByAgent } from "@/lib/ui/toasts";

const GRADIENTS = [
  "bg-gradient-to-br from-violet-500 to-indigo-600",
  "bg-gradient-to-br from-blue-500 to-cyan-600",
  "bg-gradient-to-br from-emerald-500 to-teal-600",
  "bg-gradient-to-br from-orange-500 to-amber-600",
  "bg-gradient-to-br from-rose-500 to-pink-600",
  "bg-gradient-to-br from-fuchsia-500 to-purple-600",
];

function avatarGradient(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

interface Props {
  value: string | null;
  onChange: (agentId: string) => void;
  disabled?: boolean;
}

export function AgentSelector({ value, onChange, disabled }: Props) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const unread = useUnreadByAgent();

  useEffect(() => {
    api.agents
      .list()
      .then((list) => {
        setAgents(list);
        if (!value && list.length > 0) {
          const def = list.find((a) => a.is_default) ?? list[0];
          onChange(def.id);
        }
      })
      .catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = agents.find((a) => a.id === value);
  // Aggregate unread for *other* agents — shown as a small pill next to the
  // selected agent's avatar so the user knows there's pending activity on
  // a different agent even without opening the menu.
  let otherUnread = 0;
  for (const [agentId, n] of unread) {
    if (agentId && agentId !== value) otherUnread += n;
  }

  return (
    <div className="relative">
      {/* Icon preview next to selector */}
      <div className="flex items-center gap-2">
        {selected?.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={selected.icon}
            alt={selected.name}
            className="w-5 h-5 rounded object-cover shrink-0"
          />
        ) : selected ? (
          <div className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold shrink-0 select-none text-white ${avatarGradient(selected.id)}`}>
            {selected.name.charAt(0).toUpperCase()}
          </div>
        ) : null}
        <select
          className="flex-1 bg-surface-3 text-zinc-100 text-xs rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled || agents.length === 0}
        >
          {agents.map((a) => {
            const n = unread.get(a.id) ?? 0;
            return (
              <option key={a.id} value={a.id} title={a.identity}>
                {n > 0 ? `${a.name} (${n > 9 ? "9+" : n})` : a.name}
              </option>
            );
          })}
        </select>
        {otherUnread > 0 && (
          <span
            className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-[10px] font-bold text-white flex items-center justify-center leading-none"
            title={`${otherUnread} new on other agents`}
          >
            {otherUnread > 9 ? "9+" : otherUnread}
          </span>
        )}
      </div>
    </div>
  );
}
