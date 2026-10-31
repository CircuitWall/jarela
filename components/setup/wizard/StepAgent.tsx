"use client";
import { Bot, ImagePlus, Info, Plus, Star, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { AgentConfig, AgentConfigIn, ModelConfig } from "@/api/types";
import { api } from "@/api/client";
import { AgentEditor } from "@/components/agents/AgentEditor";
import { errorMessage } from "@/lib/utils/error";
import { StepShell } from "./StepShell";

import { confirmAction } from "@/lib/ui/confirm";

interface StepAgentProps {
  agents: AgentConfig[];
  models: ModelConfig[];
  onChanged: () => void;
  readOnly?: boolean;
  starter?: {
    name: string;
    onNameChange: (value: string) => void;
    icon: string | null;
    onIconChange: (value: string | null) => void;
    goal: string;
    onGoalChange: (value: string) => void;
  };
}

export function StepAgent({ agents, models, onChanged, readOnly = false, starter }: StepAgentProps) {
  const [editing, setEditing] = useState<AgentConfig | null | "new">(null);
  const [error, setError] = useState<string | null>(null);

  if (starter) {
    return (
      <StarterAgent
        agents={agents}
        starter={starter}
        error={error}
        setError={setError}
      />
    );
  }

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
    if (!(await confirmAction({ message: `Remove agent "${agent.name}"?`, destructive: true, confirmLabel: "Remove" }))) return;
    setError(null);
    try {
      await api.agents.delete(agent.id);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <AgentManagement
      agents={agents}
      models={models}
      readOnly={readOnly}
      editing={editing}
      setEditing={setEditing}
      error={error}
      handleSave={handleSave}
      handleRemove={handleRemove}
      onChanged={onChanged}
    />
  );
}

function StarterAgent({ agents, starter, error, setError }: {
  agents: AgentConfig[];
  starter: NonNullable<StepAgentProps["starter"]>;
  error: string | null;
  setError: (error: string) => void;
}) {
  const iconInputRef = useRef<HTMLInputElement>(null);
  const existingAgent = agents.find((agent) => agent.is_default) ?? agents[0] ?? null;
  return (
    <StepShell
      icon={<Bot size={18} />}
      eyebrow="Step 4 · Your assistant"
      title={existingAgent ? "Let's get to know each other" : "Give me an identity"}
      description={existingAgent
        ? "I'll start with your current assistant, and we can get to know each other in our first chat."
        : "Choose what to call me and an optional icon. We'll shape my instructions together in our first chat."}
    >
      <>
        {existingAgent && (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-3 px-3 py-2.5">
            {existingAgent.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
              <img src={existingAgent.icon} alt="" className="h-10 w-10 rounded-lg object-cover" />
            ) : <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent"><Bot size={18} /></span>}
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">{existingAgent.name}</p>
              <p className="text-xs text-fg-faint">I&apos;ll keep your current assistant just as it is.</p>
            </div>
          </div>
        )}
        {!existingAgent && <div className="flex items-end gap-3">
          <div>
            <span className="mb-1 block text-xs font-medium text-fg-subtle">My icon <span className="font-normal text-fg-faint">Optional</span></span>
            <button
              type="button"
              onClick={() => iconInputRef.current?.click()}
              aria-label={starter.icon ? "Change assistant icon" : "Choose assistant icon"}
              className="inline-flex h-11 w-11 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-3 text-fg-faint hover:border-accent"
            >
              {starter.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
                <img src={starter.icon} alt="" className="h-full w-full object-cover" />
              ) : <ImagePlus size={17} />}
            </button>
            <input
              ref={iconInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 1024 * 1024) {
                  setError("Choose an image smaller than 1 MB.");
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result === "string") starter.onIconChange(reader.result);
                };
                reader.onerror = () => setError("Could not read that image. Try another one.");
                reader.readAsDataURL(file);
              }}
            />
          </div>
          <label className="block min-w-0 flex-1">
            <span className="mb-1 block text-xs font-medium text-fg-subtle">What should I call myself? <span className="font-normal text-fg-faint">Required</span></span>
            <input
              value={starter.name}
              onChange={(event) => starter.onNameChange(event.target.value)}
              maxLength={60}
              className="w-full rounded-xl border border-border bg-surface-3 px-3 py-2.5 text-sm focus:border-accent focus:outline-none"
              placeholder="For example, Nova"
            />
          </label>
        </div>}
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-fg-subtle">What would you like me to help with first? <span className="font-normal text-fg-faint">Optional</span></span>
          <textarea
            value={starter.goal}
            onChange={(event) => starter.onGoalChange(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="For example: help me plan projects and turn meeting notes into next steps."
            className="w-full resize-y rounded-xl border border-border bg-surface-3 px-3 py-2.5 text-sm focus:border-accent focus:outline-none"
          />
        </label>
        <p className="text-xs leading-relaxed text-fg-faint">
              I&apos;ll use this and your profile to start our first chat, ask what I&apos;m still missing, and then suggest instructions that fit you.
        </p>
        {!existingAgent && !starter.name.trim() && (
          <p className="text-xs text-fg-faint">Give me a name so we can get started.</p>
        )}
      </>
      {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </StepShell>
  );
}

function AgentManagement({ agents, models, readOnly, editing, setEditing, error, handleSave, handleRemove, onChanged }: {
  agents: AgentConfig[];
  models: ModelConfig[];
  readOnly: boolean;
  editing: AgentConfig | null | "new";
  setEditing: (agent: AgentConfig | null | "new") => void;
  error: string | null;
  handleSave: (data: AgentConfigIn) => Promise<void>;
  handleRemove: (agent: AgentConfig) => Promise<void>;
  onChanged: () => void;
}) {
  return (
    <StepShell
      icon={<Bot size={18} />}
      eyebrow="Step 4 · Create an agent"
      title={readOnly ? "Here's your assistant" : "Let's give your assistant a personality"}
      description={readOnly
        ? "I'll leave your current assistant just as it is. You can make changes later in Settings → Agents."
        : "Start with one assistant. You can shape its name, instructions, and tools as you go."}
    >
      {!readOnly && <div className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2.5 text-xs text-fg">
        <Info size={14} className="mt-0.5 shrink-0 text-accent" />
        <div className="leading-relaxed">
          <p className="font-medium">We&apos;ll keep it simple to start</p>
          <ul className="mt-1 space-y-0.5 text-fg-subtle">
            <li>• <strong>Name and identity</strong> — how your assistant introduces itself.</li>
            <li>• <strong>Instructions</strong> — the work it should focus on and how it should respond.</li>
            <li>• <strong>Model</strong> — choose from the models you connected.</li>
            <li>• <strong>Tools</strong> — optional. Add capabilities whenever you need them.</li>
          </ul>
          <p className="mt-1 text-fg-subtle">You can change everything later in Settings → Agents.</p>
        </div>
      </div>}

      {agents.length === 0 && readOnly ? (
        <p className="rounded-xl border border-border bg-surface-3 px-3 py-3 text-sm text-fg-subtle">
          No assistant is configured yet. Exit this review to return to your profile without changing anything.
        </p>
      ) : agents.length === 0 ? (
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
              onClick={readOnly ? undefined : () => setEditing(a)}
              className={`flex items-center gap-3 rounded-xl border border-border bg-surface-3 px-3 py-2.5 transition-colors ${readOnly ? "" : "cursor-pointer hover:bg-surface-3/70"}`}
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
                  {a.model_config_name ?? "automatic routing"}
                </p>
              </div>
              {!readOnly && <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleRemove(a); }}
                  className="p-1 text-fg-subtle transition-colors hover:text-red-600 dark:hover:text-red-400"
                  title="Remove"
                >
                  <Trash2 size={13} />
                </button>
              </div>}
            </div>
          ))}
          {!readOnly && <button
            type="button"
            onClick={() => setEditing("new")}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-3/40 px-4 py-2.5 text-xs text-fg-subtle transition-colors hover:border-fg-faint hover:text-fg"
          >
            <Plus size={14} /> Add another agent
          </button>}
        </div>
      )}

      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
      )}

      {!readOnly && editing !== null && (
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
