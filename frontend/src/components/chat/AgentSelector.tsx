import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { AgentInfo } from "../../api/types";

interface Props {
  value: string | null;
  onChange: (agentId: string) => void;
  disabled?: boolean;
}

export function AgentSelector({ value, onChange, disabled }: Props) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  useEffect(() => {
    api.agents.list().then(setAgents).catch(console.error);
  }, []);

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface-2">
      <span className="text-xs text-zinc-400 shrink-0">Agent</span>
      <select
        className="flex-1 bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || agents.length === 0}
      >
        {!value && <option value="">— select agent —</option>}
        {agents.map((a) => (
          <option key={a.id} value={a.id} title={a.description}>
            {a.name}
          </option>
        ))}
      </select>
    </div>
  );
}
