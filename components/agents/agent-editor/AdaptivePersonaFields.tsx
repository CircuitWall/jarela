import { Select } from "@/components/ui/Select";
import { MBTI_PRESETS, MBTI_TYPES, type MbtiType } from "@/lib/agents/adaptive-persona-presets";
import type { AgentEditorForm } from "./useAgentEditorForm";

export function AdaptivePersonaFields({ form }: { form: AgentEditorForm }) {
  const preset = MBTI_PRESETS[form.adaptiveMbti];
  return (
    <>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          className="rounded border-border"
          checked={form.adaptivePersonaEnabled}
          onChange={(e) => form.setAdaptivePersonaEnabled(e.target.checked)}
        />
        <span className="text-xs text-fg-subtle">Enable adaptive personality and emotion mirroring</span>
      </label>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">MBTI preset</span>
        <Select
          value={form.adaptiveMbti}
          onChange={(e) => form.setAdaptiveMbti(e.target.value as MbtiType)}
          disabled={!form.adaptivePersonaEnabled}
        >
          {MBTI_TYPES.map((t) => (
            <option key={t} value={t}>
              {t} - {MBTI_PRESETS[t].label}
            </option>
          ))}
        </Select>
      </label>
      <p className="text-[11px] text-fg-faint">
        Hidden preset values: strength {preset.strength}, empathy {preset.empathy}, expressiveness {preset.expressiveness}, verbosity {preset.verbosity}.
      </p>
    </>
  );
}
