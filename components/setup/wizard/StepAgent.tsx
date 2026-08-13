"use client";
import { Bot, Info, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AgentConfig, AgentConfigIn, ModelConfig } from "@/api/types";
import { api } from "@/api/client";
import { AgentEditor } from "@/components/agents/AgentEditor";
import { errorMessage } from "@/lib/utils/error";
import { StepShell } from "./StepShell";

interface StepAgentProps {
  agents: AgentConfig[];
  models: ModelConfig[];
  onChanged: () => void;
}

export function StepAgent({ agents, models, onChanged }: StepAgentProps) {
  const [editing, setEditing] = useState<AgentConfig | null | "new">(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(data: AgentConfigIn) {
    setError(null);
    try {
      if (editing === "new") await api.agents.create(data);
      else if (editing) await api.agents.update(editing.id, data);
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }

  async function handleRemove(agent: AgentConfig) {
    if (!confirm(`Remove agent "${agent.name}"?`)) return;
    setError(null);
    try {
      await api.agents.delete(agent.id);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <StepShell
      icon={<Bot size={18} />}
      eyebrow="Step 4 · Create an agent"
      title="Give your assistant a personality"
      description="An agent ties a model to a name, instructions, tools, and (optionally) a voice. You can create as many as you like — start with one."
    >
      <div className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2.5 text-xs text-fg">
        <Info size={14} className="mt-0.5 shrink-0 text-accent" />
        <div className="leading-relaxed">
          <p className="font-medium">What goes into an agent?</p>
          <ul className="mt-1 space-y-0.5 text-fg-subtle">
            <li>• <strong>Name &amp; identity</strong> — how the assistant introduces itself.</li>
            <li>• <strong>Instructions</strong> — its tone, role, and what it should focus on.</li>
            <li>• <strong>Model</strong> — pick from the model(s) you connected in the previous step.</li>
            <li>• <strong>Tools</strong> — optional. Web search, files, memory, integrations — wire them in as you go.</li>
          </ul>
          <p className="mt-1 text-fg-subtle">Defaults are sensible — you can change everything later from Settings → Agents.</p>
        </div>
      </div>

      {agents.length === 0 ? (
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border bg-surface-3/40 px-4 py-10 text-sm text-fg-subtle transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-fg"
        >
          <Plus size={20} />
          <span className="font-medium">Create your first agent</span>
          <span className="text-[11px] text-fg-faint">Opens the agent editor</span>
        </button>
      ) : (
        <div className="space-y-2">
          {agents.map((a) => (
            <div
              key={a.id}
              onClick={() => setEditing(a)}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface-3 px-3 py-2.5 cursor-pointer hover:bg-surface-3/70 transition-colors"
            >
              <Bot size={14} className="shrink-0 text-fg-subtle" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{a.name}</span>
                  {a.is_default && (
                    <Star
                      size={11}
                      className="shrink-0 fill-yellow-400 text-yellow-700 dark:text-yellow-400"
                    />
                  )}
                  {a.voice_enabled && (
                    <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-subtle">
                      voice
                    </span>
                  )}
                </div>
                <p className="truncate text-[11px] text-fg-faint">
                  {a.model_config_name ?? "no model assigned"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleRemove(a); }}
                  className="p-1 text-fg-subtle transition-colors hover:text-red-600 dark:hover:text-red-400"
                  title="Remove"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-3/40 px-4 py-2.5 text-xs text-fg-subtle transition-colors hover:border-fg-faint hover:text-fg"
          >
            <Plus size={14} /> Add another agent
          </button>
        </div>
      )}

      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
      )}

      {editing !== null && (
        <AgentEditor
          agent={editing === "new" ? undefined : editing}
          models={models}
          onSave={handleSave}
          onClose={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </StepShell>
  );
}
