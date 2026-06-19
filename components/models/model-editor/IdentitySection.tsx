import { Select } from "@/components/ui/Select";
import { TextInput } from "@/components/ui/TextField";
import type { ModelEditorForm } from "./useModelEditorForm";

export function ProviderField({ form }: { form: ModelEditorForm }) {
  return (
    <label className="block">
      <span className="text-xs text-fg-subtle mb-1 block">Provider</span>
      <Select
        value={form.provider}
        onChange={(e) => form.setProvider(e.target.value)}
      >
        {form.providers.map((p) => <option key={p} value={p}>{p}</option>)}
      </Select>
    </label>
  );
}

export function ConfigNameField({ form }: { form: ModelEditorForm }) {
  return (
    <label className="block">
      <span className="text-xs text-fg-subtle mb-1 block">Config name</span>
      <TextInput
        value={form.name}
        onChange={(e) => { form.setName(e.target.value); form.setNameTouched(true); }}
        placeholder={form.modelId || "e.g. work-claude"}
        disabled={form.isEdit}
      />
      {!form.isEdit && !form.nameTouched && form.modelId && (
        <span className="text-[10px] text-fg-faint mt-0.5 block">Auto-filled from model ID — edit to override.</span>
      )}
    </label>
  );
}
