import { Select } from "@/components/ui/Select";
import { TextInput } from "@/components/ui/TextField";
import type { ModelEditorForm } from "./useModelEditorForm";

export function IdentitySection({ form }: { form: ModelEditorForm }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Config name</span>
        <TextInput
          value={form.name}
          onChange={(e) => { form.setName(e.target.value); form.setNameTouched(true); }}
          placeholder={form.modelId || "e.g. work-claude"}
          disabled={form.isEdit}
        />
      </label>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Provider</span>
        <Select
          value={form.provider}
          onChange={(e) => form.setProvider(e.target.value)}
        >
          {form.providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
      </label>
    </div>
  );
}
