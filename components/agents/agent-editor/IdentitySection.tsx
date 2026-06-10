import { Upload } from "lucide-react";
import { MarkdownTextarea } from "@/components/ui/MarkdownTextarea";
import type { AgentEditorForm } from "./useAgentEditorForm";
import { Section } from "./Section";

export function IdentitySection({ form }: { form: AgentEditorForm }) {
  return (
    <Section step={1} title="Identity">
      <div className="flex items-end gap-3">
        <IconPicker form={form} />
        <label className="flex-1 block">
          <span className="text-xs text-fg-subtle mb-1 block">Name</span>
          <input
            className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
            value={form.name}
            onChange={(e) => form.setName(e.target.value)}
            placeholder="e.g. Code Reviewer"
            autoFocus
          />
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Persona</span>
        <MarkdownTextarea
          className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent min-h-[4rem] resize-y"
          value={form.identity}
          onChange={form.setIdentity}
          rows={3}
          placeholder="You are a senior TypeScript engineer with deep expertise in React and Next.js…"
        />
      </label>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Instructions</span>
        <MarkdownTextarea
          className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent min-h-[4rem] resize-y"
          value={form.instructions}
          onChange={form.setInstructions}
          rows={3}
          placeholder="Focus on code review, suggest best practices, and explain your reasoning…"
        />
      </label>
    </Section>
  );
}

function IconPicker({ form }: { form: AgentEditorForm }) {
  return (
    <div className="shrink-0">
      <span className="text-xs text-fg-subtle mb-1 block">Icon</span>
      <button
        onClick={() => form.iconInputRef.current?.click()}
        className="w-12 h-12 rounded-lg border-2 border-dashed border-border bg-surface-3 flex items-center justify-center hover:border-accent transition-colors overflow-hidden group"
        title="Upload image"
      >
        {form.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={form.icon} alt="icon" className="w-full h-full object-cover" />
        ) : (
          <Upload size={14} className="text-fg-faint group-hover:text-accent transition-colors" />
        )}
      </button>
      <input ref={form.iconInputRef} type="file" accept="image/*" className="hidden" onChange={form.handleIconFile} />
      {form.icon && (
        <button onClick={() => form.setIcon(null)} className="text-[10px] text-fg-faint hover:text-red-700 dark:hover:text-red-400 mt-0.5 block">
          Remove
        </button>
      )}
    </div>
  );
}
