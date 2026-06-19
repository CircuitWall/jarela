import { TextInput, TextArea } from "@/components/ui/TextField";
import type { ModelEditorForm } from "./useModelEditorForm";

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
  const showCatalog = form.autoMaxTokens !== null && form.autoMaxTokens === form.maxTokens;
  return (
    <label className="block">
      <span className="text-xs text-fg-subtle mb-1 block">
        Max tokens{showCatalog && <span className="ml-1 text-fg-faint">(catalog default)</span>}
      </span>
      <TextInput
        type="number"
        value={form.maxTokens}
        onChange={(e) => {
          form.setMaxTokens(e.target.value);
          if (e.target.value !== form.autoMaxTokens) form.setAutoMaxTokens(null);
        }}
        placeholder="4096"
      />
    </label>
  );
}

export function ContextWindowField({ form }: { form: ModelEditorForm }) {
  const showCatalog = form.autoContextWindowTokens !== null && form.autoContextWindowTokens === form.contextWindowTokens;
  return (
    <label className="block">
      <span className="text-xs text-fg-subtle mb-1 block">
        Context window tokens{showCatalog && <span className="ml-1 text-fg-faint">(catalog default)</span>}
      </span>
      <TextInput
        type="number" min="1"
        value={form.contextWindowTokens}
        onChange={(e) => {
          form.setContextWindowTokens(e.target.value);
          if (e.target.value !== form.autoContextWindowTokens) form.setAutoContextWindowTokens(null);
        }}
        placeholder="8192"
      />
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
