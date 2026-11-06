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
          <option value="model">Model — checks action claims and citations in one call</option>
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
            <option value="">Inherit global model</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} — {m.provider}/{m.model_id}
              </option>
            ))}
          </Select>
        </label>
      )}
      <p className="text-[11px] text-fg-faint">
        Model mode sends bounded excerpts of the answer, tool arguments and results, recent turns and citation sources to the configured provider in one audit call per answer; a correction can add another call. These may contain sensitive data. Findings are heuristic, not proof of an action or factual accuracy. Use a fast/cheap model. If unavailable, the action check falls back to regex and the citation audit is unavailable. Automatic retries are suppressed after a possibly state-changing tool call. Separate deterministic output validation may still run when this check is Off.
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
          Citation auditing shares the Model action-check call. Regex and Off modes do not run a model citation audit. Findings may be unavailable if a retry joins multiple answers. References can still appear in the chat UI; a matching marker is not proof that a source supports a claim.
        </span>
      </label>
      {form.citationStrictness !== "off" && form.antiHallucMode !== "model" && (
        <p className="text-[11px] text-warn">
          Citation auditing requires Model action-check mode and a configured model. If inheriting, the global mode must be Model.
        </p>
      )}
    </>
  );
}
