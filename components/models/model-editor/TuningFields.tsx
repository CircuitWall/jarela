import { TextInput, TextArea } from "@/components/ui/TextField";
import { getKnownModelLimits } from "@/lib/providers/known-context-windows";
import type { ModelEditorForm } from "./useModelEditorForm";

/**
 * The limit to advertise for the model currently in the form: the catalog value
 * from the last pick, else the curated table. Both are only hints — an empty
 * field means "automatic", and the runtime re-resolves it every turn, so the
 * saved config never freezes a number the provider later changes.
 */
function suggestedLimit(picked: string | null, known: number | null | undefined): number | null {
  const fromCatalog = Number(picked);
  if (picked && Number.isFinite(fromCatalog) && fromCatalog > 0) return fromCatalog;
  return known && known > 0 ? known : null;
}

function LimitHint({ suggested, current, unit }: { suggested: number | null; current: string; unit: string }) {
  if (suggested === null) return null;
  const value = Number(current);
  const explicit = current.trim() !== "" && Number.isFinite(value);
  return (
    <span className="text-[10px] text-fg-faint mt-0.5 block">
      {explicit && value < suggested
        ? `The model supports ${suggested.toLocaleString()} ${unit}; this lower cap is used as set.`
        : `Model limit: ${suggested.toLocaleString()} ${unit}. Leave empty to use it.`}
    </span>
  );
}

export function TemperatureMaxTokensRow({ form }: { form: ModelEditorForm }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Temperature</span>
        <TextInput
          type="number" min="0" max="2" step="0.1"
          value={form.temperature}
          onChange={(e) => form.setTemperature(e.target.value)}
          placeholder="0.7"
        />
      </label>
      <MaxTokensField form={form} />
    </div>
  );
}

function MaxTokensField({ form }: { form: ModelEditorForm }) {
  const known = getKnownModelLimits(form.provider, form.modelId)?.max_output_tokens;
  const suggested = suggestedLimit(form.autoMaxTokens, known);
  return (
    <label className="block">
      <span className="text-xs text-fg-subtle mb-1 block">Max tokens</span>
      <TextInput
        type="number"
        value={form.maxTokens}
        onChange={(e) => form.setMaxTokens(e.target.value)}
        placeholder={suggested ? `Automatic (${suggested})` : "Automatic"}
      />
      <LimitHint suggested={suggested} current={form.maxTokens} unit="output tokens" />
    </label>
  );
}

export function ContextWindowField({ form }: { form: ModelEditorForm }) {
  const known = getKnownModelLimits(form.provider, form.modelId)?.context_length;
  const suggested = suggestedLimit(form.autoContextWindowTokens, known);
  return (
    <label className="block">
      <span className="text-xs text-fg-subtle mb-1 block">Context window tokens</span>
      <TextInput
        type="number" min="1"
        value={form.contextWindowTokens}
        onChange={(e) => form.setContextWindowTokens(e.target.value)}
        placeholder={suggested ? `Automatic (${suggested})` : "Automatic"}
      />
      <LimitHint suggested={suggested} current={form.contextWindowTokens} unit="context tokens" />
    </label>
  );
}

export function ExtraHeadersField({ form }: { form: ModelEditorForm }) {
  return (
    <label className="block">
      <span className="text-xs text-fg-subtle mb-1 block">Extra headers (JSON, optional)</span>
      <TextArea
        className="font-mono h-20 resize-none"
        value={form.extraHeaders}
        onChange={(e) => form.setExtraHeaders(e.target.value)}
        placeholder='{"X-Custom": "value"}'
      />
    </label>
  );
}
