import { TextInput } from "@/components/ui/TextField";
import type { ModelEditorForm } from "./useModelEditorForm";

export function ConnectionFields({ form, expertVisible }: { form: ModelEditorForm; expertVisible: boolean }) {
  return (
    <>
      {expertVisible && !form.credentialId && <InlineApiKeyField form={form} placeholder="••••••••" />}
      {expertVisible && form.credentialId && (
        <InlineApiKeyField
          form={form}
          label="API Key override (advanced)"
          placeholder="leave blank — credential value used"
        />
      )}
      {expertVisible && (
        <label className="block">
          <span className="text-xs text-fg-subtle mb-1 block">Base URL (optional override)</span>
          <TextInput
            value={form.baseUrl}
            onChange={(e) => form.setBaseUrl(e.target.value)}
            placeholder="https://custom-endpoint"
          />
        </label>
      )}
    </>
  );
}

function InlineApiKeyField({
  form, label, placeholder,
}: { form: ModelEditorForm; label?: string; placeholder: string }) {
  return (
    <label className="block">
      <span className="text-xs text-fg-subtle mb-1 block">
        {label ?? <>API Key<span className="ml-1 text-fg-faint">(optional — env fallback used if blank)</span></>}
      </span>
      <TextInput
        type="password"
        value={form.apiKey}
        onChange={(e) => form.setApiKey(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
