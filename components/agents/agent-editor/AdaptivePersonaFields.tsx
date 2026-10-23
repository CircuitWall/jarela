import type { AgentEditorForm } from "./useAgentEditorForm";

export function AdaptivePersonaFields({ form }: { form: AgentEditorForm }) {
  const sliders = [
    { label: "Warmth", value: form.adaptiveEmpathy, set: form.setAdaptiveEmpathy, hint: "Neutral and pragmatic to warm and supportive." },
    { label: "Expressiveness", value: form.adaptiveExpressiveness, set: form.setAdaptiveExpressiveness, hint: "Reserved to lively; never exaggerates facts." },
    { label: "Response detail", value: form.adaptiveVerbosity, set: form.setAdaptiveVerbosity, hint: "Concise to detailed support after the main answer." },
    { label: "Adapt to conversational cues", value: form.adaptiveStrength, set: form.setAdaptiveStrength, hint: "0 keeps a steady style. Higher values adjust to urgency and conversational cues, not a personality diagnosis." },
  ];
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          className="rounded border-border"
          checked={form.adaptivePersonaEnabled}
          onChange={(e) => form.setAdaptivePersonaEnabled(e.target.checked)}
        />
        <span className="text-xs text-fg-subtle">Customize response style</span>
      </label>
      <p className="text-[11px] text-fg-faint">
        These controls refine the selected persona. Explicit requests and required evidence take priority.
        Turning customization off keeps the selected response organization and saves your tuned values.
      </p>
      {sliders.map(({ label, value, set, hint }) => (
        <label key={label} className="block space-y-1">
          <span className="flex justify-between text-xs text-fg-subtle">
            <span>{label}</span><span>{value}/100</span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={value}
            disabled={!form.adaptivePersonaEnabled}
            onChange={(e) => set(Number(e.target.value))}
            className="w-full accent-accent disabled:opacity-40"
            aria-label={label}
          />
          <span className="block text-[10px] text-fg-faint">{hint}</span>
        </label>
      ))}
    </div>
  );
}
