import type { ModelConfig } from "@/api/types";
import { Select } from "@/components/ui/Select";
import type { AgentEditorForm } from "./useAgentEditorForm";

export function AntiHallucinationFields({ form, models }: { form: AgentEditorForm; models: ModelConfig[] }) {
  return (
    <>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Action-claim check</span>
        <Select
          value={form.antiHallucMode}
          onChange={(e) => form.setAntiHallucMode(e.target.value as typeof form.antiHallucMode)}
        >
          <option value="">Inherit global default</option>
          <option value="off">Off — no action-claim check</option>
          <option value="regex">Regex — fast, free; catches common unfinished-action wording</option>
          <option value="model">Model — compares read/write claims with tool evidence (extra call)</option>
        </Select>
      </label>
      {(form.antiHallucMode === "model" || form.citationStrictness !== "off") && (
        <label className="block">
          <span className="text-xs text-fg-subtle mb-1 block">
            Action-check / citation model
            {form.antiHallucModel === "" && (
              <span className="ml-1 text-fg-faint">(inherits global)</span>
            )}
          </span>
          <Select value={form.antiHallucModel} onChange={(e) => form.setAntiHallucModel(e.target.value)}>
            <option value="">Inherit global for action check only</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} — {m.provider}/{m.model_id}
              </option>
            ))}
          </Select>
        </label>
      )}
      <p className="text-[11px] text-fg-faint">
        Model mode sends bounded excerpts of the answer, tool arguments and results, and up to two recent completed turns in this thread to the configured model provider. These excerpts may contain sensitive data. Evidence can be incomplete or stale; this is a heuristic, not a citation audit or proof of current state. It adds a model call; use a fast/cheap one. If unavailable, it falls back to regex. Strict citation mode upgrades this check to Model when a model is configured, unless the resolved action-check mode is Off. Automatic retries are suppressed after a possibly state-changing tool call. Separate output and citation validators may still run when this check is Off.
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
          <option value="strict">Strict — require citations for every claim</option>
        </Select>
        <span className="text-[11px] text-fg-faint mt-1">
          Citation auditing is separate from the action-claim check and may make its own model call when a model is configured for this agent. References may be tool-visited files/URLs, memory items, or prior assistant turns. The chat UI renders each <code>[N]</code> marker as a clickable link/anchor.
        </span>
      </label>
      {form.citationStrictness !== "off" && form.antiHallucModel.trim() === "" && (
        <p className="text-[11px] text-warn">
          Select an action-check / citation model above to run the citation audit for this agent. The citation audit does not use the inherited global action-check model.
        </p>
      )}
    </>
  );
}
