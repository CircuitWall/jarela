"use client";
import { CheckCircle2, Star, XCircle } from "lucide-react";
import type { Credential, IntegrationDefinition, IntegrationStatus } from "@/api/types";
import { useIntegrationCredential, type CredentialEditorMode } from "@/hooks/useIntegrationCredential";
import { useIntegrationOAuth } from "@/hooks/useIntegrationOAuth";
import { IntegrationCredentialForm } from "./IntegrationCredentialForm";
import { IntegrationCredentialActions } from "./IntegrationCredentialActions";

/** Adapts the legacy default/edit/create props to a single credential editor mode. */
export function IntegrationCard({
  definition, status, credential, createNew, onChanged, onDeleted,
}: {
  definition: IntegrationDefinition;
  status?: IntegrationStatus;
  credential?: Credential | null;
  createNew?: boolean;
  onChanged: () => void;
  onDeleted?: () => void;
}) {
  const mode: CredentialEditorMode = credential
    ? { kind: "edit", credential }
    : { kind: createNew ? "create" : "default" };
  const { state, commands } = useIntegrationCredential({ definition, status, mode, onChanged, onDeleted });
  const oauth = useIntegrationOAuth({
    integrationName: definition.name,
    credentialId: credential?.id ?? null,
    editorMode: mode.kind,
    configured: status?.configured,
    values: state.values,
    onChanged,
    onError: commands.setError,
    onResult: commands.setTestResult,
  });
  const configured = mode.kind !== "default" || status?.configured;

  return (
    <div data-deep-link-id={definition.name} className="mb-3 rounded-lg border border-border bg-surface-2 overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border/60 flex items-start gap-2">
        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 ${configured ? "bg-emerald-500" : "bg-fg-faint"}`} />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-fg flex items-center gap-2">
            <span className="truncate">{definition.label}</span>
            {credential?.is_default && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-700 bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
                <Star size={9} /> default
              </span>
            )}
            {credential && !credential.is_default && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface-3 text-fg-muted">
                additional
              </span>
            )}
          </h3>
          <p className="text-[11px] text-fg-faint mt-0.5 leading-snug">{definition.description}</p>
        </div>
      </div>
      <div className="px-3 py-3 space-y-2">
        <IntegrationCredentialForm definition={definition} status={status} mode={mode}
          values={state.values} label={state.label} setValues={commands.setValues} setLabel={commands.setLabel} />
        {state.error && (
          <div className="px-2 py-1.5 rounded bg-rose-950/40 border border-rose-800 text-xs text-rose-700 dark:text-rose-300">
            {state.error}
          </div>
        )}
        {state.testResult && (
          <div className={`px-2 py-1.5 rounded border text-xs flex items-center gap-1.5 ${
            state.testResult.ok
              ? "bg-emerald-950/30 border-emerald-800 text-emerald-700 dark:text-emerald-300"
              : "bg-rose-950/30 border-rose-800 text-rose-700 dark:text-rose-300"
          }`}>
            {state.testResult.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            <span className="truncate">{state.testResult.message}</span>
          </div>
        )}
        <IntegrationCredentialActions definition={definition} status={status} mode={mode}
          editor={{ state, commands }} oauth={oauth}
          disableTesting={!!createNew} />
      </div>
    </div>
  );
}
