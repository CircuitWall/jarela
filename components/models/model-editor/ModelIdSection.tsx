import { BookOpen } from "lucide-react";
import type { CatalogModel } from "@/api/types";
import { TextInput } from "@/components/ui/TextField";
import { CapBadges } from "../CapBadges";
import type { ModelEditorForm } from "./useModelEditorForm";

interface Props {
  form: ModelEditorForm;
  onLoadCatalog: () => Promise<void>;
}

export function ModelIdSection({ form, onLoadCatalog }: Props) {
  return (
    <div className="space-y-1.5">
      <ModelIdHeader form={form} onLoadCatalog={onLoadCatalog} />
      <TextInput
        value={form.modelId}
        onChange={(e) => {
          const next = e.target.value;
          form.setModelId(next);
          if (!form.nameTouched && !form.isEdit) form.setName(next);
        }}
        placeholder="e.g. claude-sonnet-4-6"
      />
      {form.catalogError && <p className="text-red-700 dark:text-red-400 text-xs">{form.catalogError}</p>}
      {form.showCatalog && form.catalog && <CatalogPanel form={form} />}
    </div>
  );
}

function ModelIdHeader({ form, onLoadCatalog }: Props) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-fg-subtle">Model ID</span>
      <button
        onClick={() => form.showCatalog ? form.setShowCatalog(false) : onLoadCatalog()}
        disabled={form.catalogLoading}
        className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors disabled:opacity-50"
      >
        <BookOpen size={11} />
        {form.catalogLoading ? "Loading…" : form.showCatalog ? "Hide catalog" : "Browse catalog"}
      </button>
    </div>
  );
}

function CatalogPanel({ form }: { form: ModelEditorForm }) {
  const filtered = form.catalog?.filter((m) =>
    !form.catalogSearch || m.id.toLowerCase().includes(form.catalogSearch.toLowerCase()),
  ) ?? [];
  return (
    <div className="border border-border rounded-xl overflow-hidden bg-surface-3 shadow-sm">
      <div className="px-2 py-1.5 border-b border-border bg-surface-2/50">
        <input
          className="w-full bg-surface text-fg text-xs rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent placeholder-fg-faint"
          placeholder="Filter models…"
          value={form.catalogSearch}
          onChange={(e) => form.setCatalogSearch(e.target.value)}
        />
      </div>
      <div className="max-h-52 overflow-y-auto divide-y divide-border">
        {filtered.length === 0 && (
          <p className="text-xs text-fg-faint text-center py-3">No models match</p>
        )}
        {filtered.map((m) => (
          <CatalogRow key={m.id} model={m} form={form} />
        ))}
      </div>
    </div>
  );
}

function CatalogRow({ model, form }: { model: CatalogModel; form: ModelEditorForm }) {
  return (
    <button
      onClick={() => applyCatalogPick(model, form)}
      className={`w-full text-left px-3 py-2 hover:bg-surface-2 transition-colors ${model.id === form.modelId ? "bg-accent/10 border-l-2 border-accent" : ""}`}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span className="text-xs font-mono text-fg truncate">{model.id}</span>
        {model.context_length && (
          <span className="text-[10px] text-fg-faint shrink-0">{fmtCtx(model.context_length)} ctx</span>
        )}
        {model.hosted_on && (
          <span className="text-[10px] text-fg-faint shrink-0 truncate">{model.hosted_on}</span>
        )}
      </div>
      <CapBadges caps={model.capabilities} />
    </button>
  );
}

function applyCatalogPick(model: CatalogModel, form: ModelEditorForm) {
  form.setModelId(model.id);
  if (!form.nameTouched && !form.isEdit) form.setName(model.id);
  // Auto-apply the catalog's known sizing as the default so the agent doesn't
  // fall back to the global 8K window. Only fills when the field is currently
  // empty — never clobbers a value the user explicitly typed.
  if (model.context_length && !form.contextWindowTokens.trim()) {
    const v = String(model.context_length);
    form.setContextWindowTokens(v);
    form.setAutoContextWindowTokens(v);
  }
  if (model.max_output_tokens && !form.maxTokens.trim()) {
    const v = String(model.max_output_tokens);
    form.setMaxTokens(v);
    form.setAutoMaxTokens(v);
  }
  form.setShowCatalog(false);
}

function fmtCtx(n: number | null) {
  if (!n) return null;
  return n >= 1000000 ? `${n / 1000000}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
