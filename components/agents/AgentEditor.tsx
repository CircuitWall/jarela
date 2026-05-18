"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X, Upload } from "lucide-react";
import type { AgentConfig, AgentConfigIn, ModelConfig, ToolInfo } from "@/api/types";
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
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wide">{title}</span>
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

  // Group tools by category for the sectioned UI. Categories with no tools
  // are omitted automatically. "MCP" is shown last so the user's own MCP-
  // provided tools are visually distinct from the built-in capability blocks.
  const groupedTools = useMemo(() => {
    const groups = new Map<string, ToolInfo[]>();
    for (const t of tools) {
      const cat = t.category ?? "Other";
      const arr = groups.get(cat) ?? [];
      arr.push(t);
      groups.set(cat, arr);
    }
    const CATEGORY_ORDER = [
      "Memory", "Files", "Shell", "Web", "Images",
      "Schedule", "Atlassian", "Mail", "Calendar", "Config", "Other", "MCP",
    ];
    return [...groups.entries()].sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a[0]);
      const bi = CATEGORY_ORDER.indexOf(b[0]);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  }, [tools]);

  function toggleCategory(category: string, enable: boolean) {
    const names = groupedTools.find(([c]) => c === category)?.[1].map((t) => t.name) ?? [];
    if (names.length === 0) return;
    setSelectedTools((prev) => {
      if (enable) {
        const set = new Set(prev);
        for (const n of names) set.add(n);
        return [...set];
      }
      const remove = new Set(names);
      return prev.filter((n) => !remove.has(n));
    });
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
          <h3 className="text-sm font-semibold text-fg">{isEdit ? "Edit agent" : "New agent"}</h3>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-5">

          {/* Step 1: Identity */}
          <Section step={1} title="Identity">
            <div className="flex items-end gap-3">
              <div className="shrink-0">
                <span className="text-xs text-fg-subtle mb-1 block">Icon</span>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="w-12 h-12 rounded-lg border-2 border-dashed border-border bg-surface-3 flex items-center justify-center hover:border-accent transition-colors overflow-hidden group"
                  title="Upload image"
                >
                  {icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={icon} alt="icon" className="w-full h-full object-cover" />
                  ) : (
                    <Upload size={14} className="text-fg-faint group-hover:text-accent transition-colors" />
                  )}
                </button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleIconFile} />
                {icon && (
                  <button onClick={() => setIcon(null)} className="text-[10px] text-fg-faint hover:text-red-700 dark:hover:text-red-400 mt-0.5 block">
                    Remove
                  </button>
                )}
              </div>
              <label className="flex-1 block">
                <span className="text-xs text-fg-subtle mb-1 block">Name</span>
                <input
                  className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Code Reviewer"
                  autoFocus
                />
              </label>
            </div>
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Persona</span>
              <textarea
                className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent h-16 resize-none"
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                placeholder="You are a senior TypeScript engineer with deep expertise in React and Next.js…"
              />
            </label>
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Instructions</span>
              <textarea
                className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent h-16 resize-none"
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
              className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
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
              <p className="text-[11px] text-fg-faint">
                Using <span className="text-fg-subtle">{selectedModel.provider}</span> / <span className="font-mono text-fg-muted">{selectedModel.model_id}</span>
              </p>
            )}
            {models.length === 0 && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">No model configs yet — go to the Models panel to add one first.</p>
            )}
          </Section>

          <hr className="border-border" />

          {/* Step 3: Tools */}
          <Section step={3} title="Tools">
            {tools.length === 0 ? (
              <p className="text-xs text-fg-faint">No tools available.</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-fg-faint">{selectedTools.length} of {tools.length} enabled</span>
                  <button
                    onClick={toggleAllTools}
                    className="text-[11px] text-fg-faint hover:text-fg-muted transition-colors"
                  >
                    {selectedTools.length === tools.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="space-y-1.5">
                  {groupedTools.map(([category, catTools]) => (
                    <ToolCategoryBlock
                      key={category}
                      category={category}
                      tools={catTools}
                      selected={selectedTools}
                      onToggleTool={toggleTool}
                      onToggleCategory={toggleCategory}
                    />
                  ))}
                </div>
              </>
            )}
          </Section>

          {error && <p className="text-red-700 dark:text-red-400 text-xs">{error}</p>}
        </div>

        <div className="flex items-center justify-between px-4 pb-4">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
              />
              <span className="text-xs text-fg-subtle">Set as default agent</span>
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors">
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

// Collapsible per-category block with a tri-state header checkbox. The
// header toggle flips the entire category on/off; individual tool checkboxes
// stay available for fine-grained control. Collapsed-by-default when no tool
// in the category is selected, to keep the editor compact.
function ToolCategoryBlock({
  category,
  tools,
  selected,
  onToggleTool,
  onToggleCategory,
}: {
  category: string;
  tools: ToolInfo[];
  selected: string[];
  onToggleTool: (name: string) => void;
  onToggleCategory: (category: string, enable: boolean) => void;
}) {
  const selectedInCat = tools.filter((t) => selected.includes(t.name)).length;
  const allOn = selectedInCat === tools.length;
  const someOn = selectedInCat > 0 && !allOn;
  const [open, setOpen] = useState(selectedInCat > 0);
  const headerRef = useRef<HTMLInputElement>(null);

  // Render the tri-state indeterminate dash via the DOM property (React
  // doesn't expose it as a JSX attribute).
  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someOn;
  }, [someOn]);

  return (
    <div className="rounded-lg border border-border bg-surface-1/40">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-fg-subtle hover:text-fg transition-colors"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <label className="flex items-center gap-1.5 cursor-pointer flex-1 min-w-0">
          <input
            ref={headerRef}
            type="checkbox"
            className="rounded border-border"
            checked={allOn}
            onChange={(e) => onToggleCategory(category, e.target.checked)}
          />
          <span className="text-[12px] font-semibold text-fg truncate">{category}</span>
        </label>
        <span className="text-[10px] text-fg-faint shrink-0">{selectedInCat}/{tools.length}</span>
      </div>
      {open && (
        <div className="grid grid-cols-2 gap-1.5 px-3 pb-2 pt-0.5 border-t border-border/60">
          {tools.map((t) => (
            <label key={t.name} className="flex items-center gap-1.5 cursor-pointer" title={t.description}>
              <input
                type="checkbox"
                className="rounded border-border"
                checked={selected.includes(t.name)}
                onChange={() => onToggleTool(t.name)}
              />
              <span className="font-mono text-[11px] text-fg-muted truncate">{t.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
