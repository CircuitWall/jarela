import { api } from "@/api/client";
import { Plus } from "lucide-react";
import { Select } from "@/components/ui/Select";
import type { ModelEditorForm } from "./useModelEditorForm";

export function CredentialSection({ form }: { form: ModelEditorForm }) {
  const noCredentials = form.providerCredentials.length === 0;
  // Pass-through providers (langchain, mistral, ollama, perplexity, xai, …)
  // have no INTEGRATIONS manifest, so the credential dialog has nothing to
  // render. Wait until integrations have loaded before deciding — `[]`
  // during the first render would otherwise flash the "no central
  // credential" hint for every provider.
  const hasManifest =
    form.integrations.length === 0
    || form.integrations.some((i) => i.name === form.integrationName);
  if (!hasManifest) {
    return (
      <div className="space-y-1.5">
        <span className="text-xs text-fg-subtle">Credential</span>
        <p className="rounded border border-dashed border-border bg-surface-3/40 px-3 py-2 text-[11px] leading-snug text-fg-subtle">
          <span className="font-medium text-fg-muted">{form.provider}</span>{" "}
          is a pass-through provider with no shared credential form. Set the
          API key, base URL, and any extra headers under{" "}
          <span className="font-medium text-fg-muted">Advanced settings</span>{" "}
          below — they&apos;re stored per model row.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-fg-subtle">Credential</span>
        {!noCredentials && (
          <button
            type="button"
            onClick={() => form.setCredentialDialogOpen(true)}
            className="text-[11px] text-accent hover:text-accent/80 transition-colors inline-flex items-center gap-1"
          >
            + New credential
          </button>
        )}
      </div>
      {noCredentials ? (
        <button
          type="button"
          onClick={() => form.setCredentialDialogOpen(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-border bg-surface-3/40 px-3 py-2 text-xs text-fg-subtle transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-fg"
        >
          <Plus size={12} /> Add {form.provider} credential
        </button>
      ) : (
        <CredentialDropdown form={form} />
      )}
      {form.credentialId && (
        <button
          type="button"
          onClick={() => form.setCredentialDialogOpen(true)}
          className="text-[11px] text-fg-faint hover:text-fg-muted transition-colors"
        >
          Edit selected credential
        </button>
      )}
    </div>
  );
}

function CredentialDropdown({ form }: { form: ModelEditorForm }) {
  return (
    <Select
      value={form.credentialId ?? ""}
      onChange={(e) => form.setCredentialId(e.target.value || null)}
    >
      <option value="">— Inline / env fallback —</option>
      {form.providerCredentials.map((c) => (
        <option key={c.id} value={c.id}>{c.id} ({c.auth_method})</option>
      ))}
      {form.credentialId && !form.providerCredentials.some((c) => c.id === form.credentialId) && (
        <option value={form.credentialId}>{form.credentialId} (other provider)</option>
      )}
    </Select>
  );
}

// Auto-bind a freshly-created credential so the user's next "Save model"
// uses it without re-picking. Look it up by integration name + first match.
export async function rebindCredentialAfterCreate(form: ModelEditorForm) {
  try {
    const rows = await api.credentials.list({ type: "integration", provider: form.integrationName });
    form.setCredentials((prev) => {
      const merged = [...prev.filter((c) => !rows.some((r) => r.id === c.id)), ...rows];
      return merged;
    });
    if (rows.length > 0 && !form.credentialId) form.setCredentialId(rows[0].id);
  } catch { /* refresh-only failure is non-fatal */ }
}
