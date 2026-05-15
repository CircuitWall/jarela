"use client";
import { useEffect, useRef, useState } from "react";
import { X, Upload } from "lucide-react";
import type { AgentConfig, AgentConfigIn, ModelConfig } from "@/api/types";
import { useTools } from "@/hooks/useTools";

interface Props {
  agent?: AgentConfig;
  models: ModelConfig[];
  onSave: (data: AgentConfigIn) => Promise<void>;
  onClose: () => void;
}

function Section({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-accent text-white text-[10px] font-bold flex items-center justify-center shrink-0">
          {step}
        </span>
        <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">{title}</span>
      </div>
      <div className="ml-7 space-y-2">{children}</div>
    </div>
  );
}

export function AgentEditor({ agent, models, onSave, onClose }: Props) {
  const isEdit = !!agent;
  const { tools } = useTools();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(agent?.name ?? "");
  const [icon, setIcon] = useState<string | null>(agent?.icon ?? null);
  const [modelConfigName, setModelConfigName] = useState<string>(agent?.model_config_name ?? "");
  const [identity, setIdentity] = useState(agent?.identity ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [selectedTools, setSelectedTools] = useState<string[]>(agent?.tools ?? []);
  const [isDefault, setIsDefault] = useState<boolean>(agent?.is_default ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleIconFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setIcon(reader.result as string);
    reader.readAsDataURL(file);
  }

  function toggleTool(toolName: string) {
    setSelectedTools((p) => p.includes(toolName) ? p.filter((n) => n !== toolName) : [...p, toolName]);
  }

  function toggleAllTools() {
    setSelectedTools((p) => p.length === tools.length ? [] : tools.map((t) => t.name));
  }

  async function handleSave() {
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        icon: icon ?? null,
        identity: identity.trim(),
        instructions: instructions.trim(),
        tools: selectedTools,
        model_config_name: modelConfigName || null,
        is_default: isDefault,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const selectedModel = models.find((m) => m.name === modelConfigName);
  const defaultModel = models.find((m) => m.is_default);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto">
      <div className="bg-surface-2 border border-border rounded-2xl w-full max-w-lg shadow-xl my-2 sm:my-4">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-zinc-100">{isEdit ? "Edit agent" : "New agent"}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-5">

          {/* Step 1: Identity */}
          <Section step={1} title="Identity">
            <div className="flex items-end gap-3">
              <div className="shrink-0">
                <span className="text-xs text-zinc-400 mb-1 block">Icon</span>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="w-12 h-12 rounded-lg border-2 border-dashed border-border bg-surface-3 flex items-center justify-center hover:border-accent transition-colors overflow-hidden group"
                  title="Upload image"
                >
                  {icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={icon} alt="icon" className="w-full h-full object-cover" />
                  ) : (
                    <Upload size={14} className="text-zinc-500 group-hover:text-accent transition-colors" />
                  )}
                </button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleIconFile} />
                {icon && (
                  <button onClick={() => setIcon(null)} className="text-[10px] text-zinc-500 hover:text-red-400 mt-0.5 block">
                    Remove
                  </button>
                )}
              </div>
              <label className="flex-1 block">
                <span className="text-xs text-zinc-400 mb-1 block">Name</span>
                <input
                  className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Code Reviewer"
                  autoFocus
                />
              </label>
            </div>
            <label className="block">
              <span className="text-xs text-zinc-400 mb-1 block">Persona</span>
              <textarea
                className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent h-16 resize-none"
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                placeholder="You are a senior TypeScript engineer with deep expertise in React and Next.js…"
              />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-400 mb-1 block">Instructions</span>
              <textarea
                className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent h-16 resize-none"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Focus on code review, suggest best practices, and explain your reasoning…"
              />
            </label>
          </Section>

          <hr className="border-border" />

          {/* Step 2: Model */}
          <Section step={2} title="Model">
            <select
              className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
              value={modelConfigName}
              onChange={(e) => setModelConfigName(e.target.value)}
            >
              <option value="">
                {defaultModel ? `Default (${defaultModel.name} · ${defaultModel.model_id})` : "(no default configured)"}
              </option>
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} · {m.provider} / {m.model_id}
                </option>
              ))}
            </select>
            {selectedModel && (
              <p className="text-[11px] text-zinc-500">
                Using <span className="text-zinc-400">{selectedModel.provider}</span> / <span className="font-mono text-zinc-300">{selectedModel.model_id}</span>
              </p>
            )}
            {models.length === 0 && (
              <p className="text-[11px] text-amber-400">No model configs yet — go to the Models panel to add one first.</p>
            )}
          </Section>

          <hr className="border-border" />

          {/* Step 3: Tools */}
          <Section step={3} title="Tools">
            {tools.length === 0 ? (
              <p className="text-xs text-zinc-500">No tools available.</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-zinc-500">{selectedTools.length} of {tools.length} enabled</span>
                  <button
                    onClick={toggleAllTools}
                    className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {selectedTools.length === tools.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {tools.map((t) => (
                    <label key={t.name} className="flex items-center gap-1.5 cursor-pointer" title={t.description}>
                      <input
                        type="checkbox"
                        className="rounded border-border"
                        checked={selectedTools.includes(t.name)}
                        onChange={() => toggleTool(t.name)}
                      />
                      <span className="font-mono text-[11px] text-zinc-300 truncate">{t.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </Section>

          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>

        <div className="flex items-center justify-between px-4 pb-4">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="rounded border-border"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            <span className="text-xs text-zinc-400">Set as default agent</span>
          </label>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
