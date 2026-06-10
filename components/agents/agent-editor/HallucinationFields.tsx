import type { ModelConfig } from "@/api/types";
import { Select } from "@/components/ui/Select";
import type { AgentEditorForm } from "./useAgentEditorForm";

export function AntiHallucinationFields({ form, models }: { form: AgentEditorForm; models: ModelConfig[] }) {
  return (
    <>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Anti-hallucination detector</span>
        <Select
          value={form.antiHallucMode}
          onChange={(e) => form.setAntiHallucMode(e.target.value as typeof form.antiHallucMode)}
        >
          <option value="">Inherit global default</option>
          <option value="off">Off — no detection</option>
          <option value="regex">Regex — fast, free, brittle</option>
          <option value="model">Model — LLM classifier (more accurate, +1 call/turn)</option>
        </Select>
      </label>
      {form.antiHallucMode === "model" && (
        <label className="block">
          <span className="text-xs text-fg-subtle mb-1 block">
            Classifier model
            {form.antiHallucModel === "" && (
              <span className="ml-1 text-fg-faint">(inherits global)</span>
            )}
          </span>
          <Select value={form.antiHallucModel} onChange={(e) => form.setAntiHallucModel(e.target.value)}>
            <option value="">Inherit global JARELA_HALLUCINATION_DETECTOR_MODEL</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} — {m.provider}/{m.model_id}
              </option>
            ))}
          </Select>
        </label>
      )}
      <p className="text-[11px] text-fg-faint">
        When set to <em>model</em>, every assistant turn for this agent runs through an LLM classifier that judges whether the agent stalled (narrated future work without invoking a write tool). Pick a fast/cheap config (e.g. Haiku, gpt-4o-mini, gemini-flash). If no model is configured here or globally, falls back to <em>regex</em>.
      </p>
    </>
  );
}

export function CitationStrictnessField({ form }: { form: AgentEditorForm }) {
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-fg-subtle">Citation strictness</span>
        <Select
          value={form.citationStrictness}
          onChange={(e) => form.setCitationStrictness(e.target.value as typeof form.citationStrictness)}
        >
          <option value="off">Off — no checker, no nudge to cite</option>
          <option value="informational">Informational — checker surfaces references; agent NOT asked to cite</option>
          <option value="standard">Standard — nudge agent to cite KEY (load-bearing) claims</option>
          <option value="strict">Strict — cite EVERY claim; force model-based stall detector</option>
        </Select>
        <span className="text-[11px] text-fg-faint mt-1">
          The audit (a second-pass LLM that ranks each factual claim by impact) runs whenever strictness is not <em>off</em>. References may be tool-visited files/URLs, memory items, or prior assistant turns. The chat UI renders each <code>[N]</code> marker as a clickable link/anchor.
        </span>
      </label>
      {form.citationStrictness !== "off" && form.antiHallucModel.trim() === "" && (
        <p className="text-[11px] text-warn">
          Pick a classifier model above (or set <em>Anti-hallucination detector</em> to <em>model</em>) so the citation audit has somewhere to run. Without it, the system-prompt directive is added but no verification happens.
        </p>
      )}
    </>
  );
}
