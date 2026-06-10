import type { ModelEditorForm } from "./useModelEditorForm";

export function IdentitySection({ form }: { form: ModelEditorForm }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Config name</span>
        <input
          className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          value={form.name}
          onChange={(e) => { form.setName(e.target.value); form.setNameTouched(true); }}
          placeholder={form.modelId || "e.g. work-claude"}
          disabled={form.isEdit}
        />
      </label>
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Provider</span>
        <select
          className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
          value={form.provider}
          onChange={(e) => form.setProvider(e.target.value)}
        >
          {form.providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
    </div>
  );
}
