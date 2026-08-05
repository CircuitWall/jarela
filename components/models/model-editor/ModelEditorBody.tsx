"use client";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { AddCredentialDialog } from "@/components/credentials/AddCredentialDialog";
import { ModelFeatureGuide } from "../ModelFeatureGuide";
import { ProviderLogo } from "../ProviderLogo";
import type { ModelEditorForm } from "./useModelEditorForm";
import { ConfigNameField, ProviderField } from "./IdentitySection";
import { ModelIdSection } from "./ModelIdSection";
import { CredentialSection, rebindCredentialAfterCreate } from "./CredentialSection";
import { ConnectionFields } from "./ConnectionFields";
import { ContextWindowField, ExtraHeadersField, TemperatureMaxTokensRow } from "./TuningFields";
import { GitHubCopilotAuth } from "./GitHubCopilotAuth";
import { ProbeBanner } from "./ProbeAndFooter";
import { ShrinkConfirmDialog } from "./ShrinkConfirmDialog";

function AdvancedFieldsSection({ form }: { form: ModelEditorForm }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-surface-1/30 p-3">
      <div
        className="flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
        role="button"
        aria-expanded={open}
      >
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Advanced settings</span>
        <ChevronDown size={13} className={`ml-auto text-fg-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </div>
      {open && (
        <div className="mt-2.5 space-y-3">
          <ConnectionFields form={form} />
          <TemperatureMaxTokensRow form={form} />
          <ContextWindowField form={form} />
          <ExtraHeadersField form={form} />
        </div>
      )}
    </div>
  );
}

interface BodyProps {
  form: ModelEditorForm;
  onLoadCatalog: () => Promise<void>;
}

export function ModelEditorBody({ form, onLoadCatalog }: BodyProps) {
  return (
    <>
      <div className="flex items-end gap-3">
        <div className="shrink-0 pb-1 text-fg-subtle">
          <ProviderLogo name={form.provider} size={28} />
        </div>
        <div className="flex-1 min-w-0">
          <ProviderField form={form} />
        </div>
      </div>
      {form.provider === "github-copilot" && <GitHubCopilotAuth />}
      <CredentialSection form={form} />
      <ModelIdSection form={form} onLoadCatalog={onLoadCatalog} />
      <ConfigNameField form={form} />
      <ModelFeatureGuide
        provider={form.provider}
        modelId={form.modelId}
        models={form.model ? [form.model] : []}
        integrations={form.integrations}
      />
      <AdvancedFieldsSection form={form} />
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
