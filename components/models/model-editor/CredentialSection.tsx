import { api } from "@/api/client";
import { Select } from "@/components/ui/Select";
import type { ModelEditorForm } from "./useModelEditorForm";

export function CredentialSection({ form }: { form: ModelEditorForm }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-fg-subtle">Credential</span>
        <button
          type="button"
          onClick={() => form.setCredentialDialogOpen(true)}
          className="text-[11px] text-accent hover:text-accent/80 transition-colors inline-flex items-center gap-1"
        >
          + New credential
        </button>
      </div>
      <CredentialDropdown form={form} />
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
  const emptyLabel = form.providerCredentials.length === 0
    ? `— No credentials for ${form.provider} —`
    : "— Inline / env fallback —";
  return (
    <Select
      value={form.credentialId ?? ""}
      onChange={(e) => form.setCredentialId(e.target.value || null)}
    >
      <option value="">{emptyLabel}</option>
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
