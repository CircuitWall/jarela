"use client";
import { Terminal } from "lucide-react";
import type { IntegrationDefinition, IntegrationField, IntegrationStatus } from "@/api/types";
import { isMaskedSecret } from "@/lib/utils/secret-mask";
import type { CredentialEditorMode } from "@/hooks/useIntegrationCredential";
import { ClaudeCodeSetupGuide, GmailSetupGuide, OutlookSetupGuide } from "./IntegrationSetupGuides";

export function IntegrationCredentialForm({
  definition: def, status, mode, values, label, setValues, setLabel,
}: {
  definition: IntegrationDefinition;
  status?: IntegrationStatus;
  mode: CredentialEditorMode;
  values: Record<string, string>;
  label: string;
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setLabel: (label: string) => void;
}) {
  const isDefault = mode.kind !== "edit" || mode.credential.is_default;
  return (
    <>
      {def.name === "claude-code" && <ClaudeCodeSetupGuide />}
      {def.name === "outlook" && <OutlookSetupGuide />}
      <label className="block text-xs text-fg-subtle">
        <span>Label <span className="text-fg-faint">(optional, e.g. &ldquo;Work&rdquo;, &ldquo;Personal&rdquo;)</span></span>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)}
          placeholder={isDefault ? "Default credential" : "Untitled credential"}
          className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg" />
      </label>
      {def.name === "claude-code" ? (
        <ClaudeCodeFields def={def} values={values} setValues={setValues} status={status} />
      ) : def.name === "gmail" ? (
        <details className="rounded border border-border/60 bg-surface-3/30">
          <summary className="cursor-pointer select-none px-2.5 py-1.5 text-xs text-fg-subtle hover:bg-surface-3">
            Advanced — bring your own OAuth client
          </summary>
          <div className="px-3 py-2.5 space-y-2 border-t border-border/60">
            <GmailSetupGuide />
            {def.fields.map((field) => renderField(field, values, setValues, status))}
          </div>
        </details>
      ) : def.fields.map((field) => renderField(field, values, setValues, status))}
    </>
  );
}


const CLAUDE_CONNECTION_FIELDS = new Set([
  "cli_path",
  "api_key",
  "auth_token",
  "base_url",
  "default_opus_model",
  "default_sonnet_model",
  "default_haiku_model",
]);


function ClaudeCodeFields({
  def,
  values,
  setValues,
  status,
}: {
  def: IntegrationDefinition;
  values: Record<string, string>;
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  status?: IntegrationStatus;
}) {
  const connection = def.fields.filter((f) => CLAUDE_CONNECTION_FIELDS.has(f.key));
  const launch = def.fields.filter((f) => !CLAUDE_CONNECTION_FIELDS.has(f.key));
  return (
    <div className="space-y-2">
      <div className="rounded border border-border/60 bg-surface-3/20 p-2 space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-fg-faint">Connection</div>
        {connection.map((f) => renderField(f, values, setValues, status))}
      </div>
      <div className="rounded border border-border/60 bg-surface-3/20 p-2 space-y-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-fg-faint">Launch defaults</div>
          <p className="mt-0.5 text-[11px] text-fg-faint leading-snug">
            These defaults apply whenever an agent calls <code className="text-fg">claude_delegate</code> without an explicit override.
          </p>
        </div>
        {launch.map((f) => renderField(f, values, setValues, status))}
      </div>
    </div>
  );
}


function renderField(
  f: IntegrationField,
  values: Record<string, string>,
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  status?: IntegrationStatus,
) {
  const fieldSource = status?.source?.[f.key];
  return (
    <label key={f.key} className="block text-xs text-fg-subtle">
      <span className="flex items-center gap-1.5">
        {f.label}{f.required && <span className="text-rose-700 dark:text-rose-400 ml-0.5">*</span>}
        {fieldSource === "rc" && (
          <span
            title="Value pulled from your shell rc / Windows User env. Editing here will switch this field to manual mode."
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/30"
          >
            <Terminal size={9} /> from shell
          </span>
        )}
      </span>
      <input
        type={f.secret ? "password" : "text"}
        value={values[f.key] ?? ""}
        onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.value }))}
        onFocus={(e) => {
          // Clicking a masked secret field clears it so the user can type a
          // new value without manually selecting and replacing the dots.
          // Accept either sentinel shape (`"***"` from the credentials API,
          // `"********"` from the legacy integrations status route).
          if (f.secret && isMaskedSecret(e.target.value)) {
            setValues((p) => ({ ...p, [f.key]: "" }));
          }
        }}
        placeholder={f.placeholder}
        className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg font-mono"
      />
    </label>
  );
}
