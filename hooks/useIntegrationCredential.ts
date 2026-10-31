"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Credential, IntegrationDefinition, IntegrationStatus } from "@/api/types";
import { confirmAction } from "@/lib/ui/confirm";
import { errorMessage } from "@/lib/utils/error";
import { isMaskedSecret } from "@/lib/utils/secret-mask";

export type CredentialEditorMode =
  | { kind: "default" }
  | { kind: "create" }
  | { kind: "edit"; credential: Credential };

export interface CredentialTestResult {
  ok: boolean;
  message: string;
}

interface EditorOptions {
  definition: IntegrationDefinition;
  mode: CredentialEditorMode;
  status?: IntegrationStatus;
  onChanged: () => void;
  onDeleted?: () => void;
}

function initialValues(def: IntegrationDefinition, mode: CredentialEditorMode, status?: IntegrationStatus) {
  if (mode.kind !== "edit") return { ...status?.values };
  const values: Record<string, string> = {};
  const params: Record<string, unknown> = mode.credential.params;
  for (const field of def.fields) {
    const raw = params[field.key];
    if (raw != null) values[field.key] = String(raw);
  }
  return values;
}

async function saveCredential(
  def: IntegrationDefinition, mode: CredentialEditorMode, values: Record<string, string>, label: string,
  onDefaultSaved: (saved: IntegrationStatus) => void,
): Promise<void> {
  const name = label.trim();
  if (mode.kind === "default") {
    const saved = await api.integrations.save(def.name, values);
    onDefaultSaved(saved);
    if (name) {
      const rows = await api.credentials.list({ type: "integration", provider: def.name });
      const credential = rows.find((row) => row.is_default);
      if (!credential) throw new Error("Credentials saved, but no default credential was found to update its label.");
      await api.credentials.update(credential.id, { label: name });
    }
    return;
  }
  const data = {
    label: name || null,
    params: Object.fromEntries(Object.entries(values).filter(([, value]) => !isMaskedSecret(value))),
  };
  if (mode.kind === "edit") {
    await api.credentials.update(mode.credential.id, data);
  } else {
    const keys = new Set(def.fields.map((field) => field.key));
    await api.credentials.create({
      type: "integration", provider: def.name,
      auth_method: keys.has("client_id") && keys.has("client_secret") ? "oauth" : "api_key",
      ...data,
    });
  }
}

function connectionResult(result: Awaited<ReturnType<typeof api.integrations.test>>): CredentialTestResult {
  if (!result.ok) return { ok: false, message: result.error ?? "Test failed" };
  const detail = result.detail;
  const text = (key: string) => typeof detail?.[key] === "string" ? detail[key] : "";
  const identity = text("displayName") || text("email");
  let message = "Connection ok";
  if (text("version")) message = `Claude Code ${text("auth") === "api_key" ? "ready" : "detected"} (${text("version")})`;
  if (identity) message = `Connected as ${identity}`;
  return { ok: true, message: text("warning") || message };
}

/** Owns credential form state and mode-specific actions, independently of layout. */
export function useIntegrationCredential({ definition: def, mode, status, onChanged, onDeleted }: EditorOptions) {
  const credential = mode.kind === "edit" ? mode.credential : null;
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(def, mode, status));
  const [label, setLabel] = useState(credential?.label ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CredentialTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef({ active: true });

  useEffect(() => {
    const session = { active: true };
    sessionRef.current = session;
    setSaving(false);
    setTesting(false);
    setError(null);
    setTestResult(null);
    return () => { session.active = false; };
  }, [def.name, mode.kind, credential?.id]);

  useEffect(() => {
    setValues(initialValues(def, mode, status));
    // Refresh saved masks, not every new status object, to preserve unsaved edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.name, mode.kind, status?.updated_at, credential?.id, credential?.updated_at]);

  useEffect(() => {
    setLabel(credential?.label ?? "");
    // Labels follow the same saved-version boundary as field values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.name, mode.kind, credential?.id, credential?.updated_at]);

  async function save() {
    const session = sessionRef.current;
    setError(null);
    setSaving(true);
    try {
      await saveCredential(def, mode, values, label, (saved) => {
        if (session.active) {
          setValues({ ...saved.values });
          setTestResult(null);
        }
      });
      if (!session.active) return;
      setTestResult(null);
      onChanged();
    } catch (e) {
      if (session.active) setError(errorMessage(e));
    } finally {
      if (session.active) setSaving(false);
    }
  }

  async function test() {
    const session = sessionRef.current;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.integrations.test(def.name, credential?.id);
      if (session.active) setTestResult(connectionResult(result));
    } catch (e) {
      if (session.active) setTestResult({ ok: false, message: errorMessage(e) });
    } finally {
      if (session.active) setTesting(false);
    }
  }

  async function remove() {
    if (mode.kind === "create") return;
    const session = sessionRef.current;
    const options = credential
      ? { message: `Delete credential "${label || credential.id}"?`, destructive: true }
      : { message: `Remove saved credentials for ${def.label}?`, destructive: true, confirmLabel: "Remove" };
    if (!(await confirmAction(options)) || !session.active) return;
    try {
      if (credential) {
        await api.credentials.delete(credential.id);
      } else {
        await api.integrations.delete(def.name);
        if (!session.active) return;
        setValues({});
        setTestResult(null);
      }
      if (!session.active) return;
      onChanged();
      if (credential) onDeleted?.();
    } catch (e) {
      if (session.active) setError(errorMessage(e));
    }
  }

  async function promoteToDefault() {
    if (!credential) return;
    const session = sessionRef.current;
    try {
      await api.credentials.update(credential.id, { is_default: true });
      if (session.active) onChanged();
    } catch (e) {
      if (session.active) setError(errorMessage(e));
    }
  }

  const state = { values, label, saving, testing, testResult, error };
  const commands = { setValues, setLabel, setError, setTestResult, save, test, remove, promoteToDefault };
  return { state, commands, ...state, ...commands };
}
