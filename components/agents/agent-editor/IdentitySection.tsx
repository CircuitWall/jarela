import { Upload } from "lucide-react";
import { MarkdownTextarea } from "@/components/ui/MarkdownTextarea";
import { TextInput, FIELD_CLASS } from "@/components/ui/TextField";
import type { AgentEditorForm } from "./useAgentEditorForm";
import { Section } from "./Section";
import { USAGE_PROFILES, USAGE_PROFILE_VALUES } from "@/lib/agents/usage-profile";
import { AdaptivePersonaFields } from "./AdaptivePersonaFields";
import { DialogError } from "@/components/ui/DialogFooter";

export function IdentitySection({ form }: { form: AgentEditorForm }) {
  return (
    <Section step={1} title="Identity">
      <div className="flex items-end gap-3">
        <IconPicker form={form} />
        <label className="flex-1 block">
          <span className="text-xs text-fg-subtle mb-1 block">Name</span>
          <TextInput
            value={form.name}
            onChange={(e) => form.setName(e.target.value)}
            placeholder="e.g. Code Reviewer"
            autoFocus
          />
        </label>
      </div>
      <DialogError message={form.iconError} />
      <fieldset className="space-y-2">
        <legend className="text-xs text-fg-subtle">Persona</legend>
        <p className="text-[11px] text-fg-faint">
          Choose how this agent communicates, displays technical details, and filters credential discovery.
          Saved credentials and tool permissions are unchanged.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {USAGE_PROFILE_VALUES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={form.usageProfile === value}
              onClick={() => form.selectUsageProfile(value)}
              className={`text-left px-3 py-2.5 rounded-xl border transition-colors ${
                form.usageProfile === value
                  ? "border-accent/60 bg-accent/15 text-fg"
                  : "border-border bg-surface-3 text-fg-muted hover:text-fg"
              }`}
            >
              <div className="text-xs font-medium">{USAGE_PROFILES[value].label}</div>
              <div className="text-[10px] text-fg-faint mt-0.5">{USAGE_PROFILES[value].hint}</div>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-fg-faint">
          Selecting Home, Work, or Developer applies editable style defaults.
          Home and Work suggest standard citations; Developer suggests strict citations.
          Grounding remains independently editable in Advanced settings.
          Custom / Everything keeps your current style and grounding settings.
          Failures and approvals stay visible in every profile.
        </p>
        <AdaptivePersonaFields form={form} />
      </fieldset>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Role and identity</span>
        <MarkdownTextarea
          className={`${FIELD_CLASS} min-h-[4rem] resize-y`}
          value={form.identity}
          onChange={form.setIdentity}
          rows={3}
          placeholder="You are a senior TypeScript engineer with deep expertise in React and Next.js…"
        />
      </label>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Instructions</span>
        <MarkdownTextarea
          className={`${FIELD_CLASS} min-h-[4rem] resize-y`}
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
