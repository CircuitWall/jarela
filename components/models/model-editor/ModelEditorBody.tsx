"use client";
import { AddCredentialDialog } from "@/components/credentials/AddCredentialDialog";
import { ModelFeatureGuide } from "../ModelFeatureGuide";
import type { ModelEditorForm } from "./useModelEditorForm";
import { IdentitySection } from "./IdentitySection";
import { ModelIdSection } from "./ModelIdSection";
import { CredentialSection, rebindCredentialAfterCreate } from "./CredentialSection";
import { ConnectionFields } from "./ConnectionFields";
import { ContextWindowField, ExtraHeadersField, TemperatureMaxTokensRow } from "./TuningFields";
import { GitHubCopilotAuth } from "./GitHubCopilotAuth";
import { ProbeBanner } from "./ProbeAndFooter";
import { ShrinkConfirmDialog } from "./ShrinkConfirmDialog";

interface BodyProps {
  form: ModelEditorForm;
  expertVisible: boolean;
  onLoadCatalog: () => Promise<void>;
}

export function ModelEditorBody({ form, expertVisible, onLoadCatalog }: BodyProps) {
  return (
    <>
      <IdentitySection form={form} />
      <ModelIdSection form={form} onLoadCatalog={onLoadCatalog} />
      <ModelFeatureGuide
        provider={form.provider}
        modelId={form.modelId}
        models={form.model ? [form.model] : []}
        integrations={form.integrations}
      />
      {form.provider === "github-copilot" && <GitHubCopilotAuth />}
      <CredentialSection form={form} />
      <ConnectionFields form={form} expertVisible={expertVisible} />
      <TemperatureMaxTokensRow form={form} />
      {expertVisible && <ContextWindowField form={form} />}
      {expertVisible && <ExtraHeadersField form={form} />}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox" className="rounded border-border"
          checked={form.isDefault}
          onChange={(e) => form.setIsDefault(e.target.checked)}
        />
        <span className="text-xs text-fg-muted">Set as default model</span>
      </label>
      {form.error && <p className="text-red-700 dark:text-red-400 text-xs">{form.error}</p>}
      <ProbeBanner result={form.probeResult} />
    </>
  );
}

interface OverlayProps {
  form: ModelEditorForm;
  onConfirmShrink: () => void;
  onSkipShrink: () => void;
}

export function ModelEditorOverlays({ form, onConfirmShrink, onSkipShrink }: OverlayProps) {
  return (
    <>
      <ShrinkConfirmDialog form={form} onConfirm={onConfirmShrink} onSkip={onSkipShrink} />
      {form.credentialDialogOpen && (
        <AddCredentialDialog
          initialCategory="llm"
          directProviderName={form.integrationName}
          lockCategory
          onClose={() => { form.setCredentialDialogOpen(false); form.refreshCredentials(); }}
          onSaved={() => rebindCredentialAfterCreate(form)}
        />
      )}
    </>
  );
}
