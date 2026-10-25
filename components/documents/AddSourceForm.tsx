"use client";
import { useState } from "react";
import type { api } from "@/api/client";
import type { DocumentSourceKind } from "@/api/types";
import { FolderPickerDialog } from "./FolderPickerDialog";
import { KIND_OPTIONS, isGithubKind, isMailKind, integrationForSourceKind } from "./helpers";
import {
  LocalFolderFields,
  RemoteSourceFields,
  makeSetField,
  type FormState,
} from "./AddSourceFields";

type CreatePayload = Parameters<typeof api.documents.createSource>[0];

interface Props {
  disabled: boolean;
  onSubmit: (payload: CreatePayload) => Promise<boolean>;
  configuredIntegrations: string[];
  localEmbeddings: boolean | null;
}

const INITIAL: FormState = {
  addKind: "local_folder",
  addPath: "",
  addLabel: "",
  addProjectKey: "",
  addSpaceKey: "",
  addQuery: "",
  addMailQuery: "",
  addMailScope: "inbox",
  addMailFolder: "",
  addMailMaxResults: "",
  addMailPageSize: "",
  addRecencyDays: "",
  addGhOwner: "",
  addGhRepo: "",
  addGhRef: "",
  addGhPathPrefix: "",
  addGhState: "all",
};

function buildPayload(s: FormState): CreatePayload | null {
  const label = s.addLabel.trim();
  if (s.addKind === "local_folder") {
    const trimmedPath = s.addPath.trim();
    if (!trimmedPath) return null;
    return { path: trimmedPath, label: label || null };
  }
  const config: Record<string, unknown> = {};
  if (s.addKind === "jira_project") {
    if (!s.addProjectKey.trim()) return null;
    config.project_key = s.addProjectKey.trim();
  } else if (s.addKind === "confluence_space") {
    if (!s.addSpaceKey.trim()) return null;
    config.space_key = s.addSpaceKey.trim();
  } else if (s.addKind === "jira_jql") {
    if (!s.addQuery.trim()) return null;
    config.jql = s.addQuery.trim();
  } else if (s.addKind === "confluence_cql") {
    if (!s.addQuery.trim()) return null;
    config.cql = s.addQuery.trim();
  } else if (isGithubKind(s.addKind)) {
    const owner = s.addGhOwner.trim();
    const repo = s.addGhRepo.trim();
    if (!owner || !repo) return null;
    config.owner = owner;
    config.repo = repo;
    if (s.addKind === "github_pulls") {
      config.state = s.addGhState;
    } else {
      const ref = s.addGhRef.trim();
      if (ref) config.ref = ref;
      const prefix = s.addGhPathPrefix.trim().replace(/^\/+|\/+$/g, "");
      if (prefix) config.path_prefix = prefix;
    }
  } else if (isMailKind(s.addKind)) {
    config.scope = s.addMailScope;
    config.retention = "archive";
    if (s.addMailScope === "folder") {
      if (!s.addMailFolder.trim()) return null;
      config.folder = s.addMailFolder.trim();
    }
    if (s.addMailQuery.trim()) config.query = s.addMailQuery.trim();
    for (const [raw, key, maximum] of [
      [s.addMailMaxResults, "max_results", Infinity],
      [s.addMailPageSize, "page_size", 100],
    ] as const) {
      if (!raw.trim()) continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > maximum) return null;
      config[key] = value;
    }
  }
  const recency = parseInt(s.addRecencyDays, 10);
  if (Number.isFinite(recency) && recency > 0) config.recency_days = recency;
  if (!label) return null;
  return { kind: s.addKind, label, config };
}

function kindHint(kind: DocumentSourceKind): string {
  if (kind === "local_folder") return "Pick a folder on this machine.";
  if (kind === "gmail_mail") return "Requires Gmail credentials (Credentials → Gmail).";
  if (kind === "outlook_mail") return "Requires Outlook credentials (Credentials → Outlook).";
  if (kind === "icloud_mail") return "Requires iCloud credentials (Credentials → iCloud).";
  if (isGithubKind(kind)) return "Requires GitHub credentials (Credentials → GitHub).";
  return "Requires Atlassian credentials (Credentials → Atlassian).";
}

export function AddSourceForm({ disabled, onSubmit, configuredIntegrations, localEmbeddings }: Props) {
  const [state, setState] = useState<FormState>(INITIAL);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const set = makeSetField(setState);
  const payload = buildPayload(state);

  async function handleSubmit() {
    if (!payload || !consent || submitting) return;
    setSubmitting(true);
    try {
      if (!(await onSubmit(payload))) return;
      setState({ ...INITIAL, addKind: state.addKind });
      setConsent(false);
    } catch {
      // parent surfaces the error; keep form state for retry.
    } finally {
      setSubmitting(false);
    }
  }

  const fieldProps = {
    state,
    set,
    disabled: disabled || submitting,
    canSubmit: payload !== null && consent,
    onSubmit: () => void handleSubmit(),
  };

  return (
    <section className="space-y-2">
      <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Opt in to indexing</label>
      <p className="text-xs text-fg-faint">
        Choose a folder or a supported connected integration, then select the mailbox scope, repository, or project to index.
        Connecting credentials alone does not enable indexing. Other tools without a document indexer are not listed.
      </p>
      <div className="flex items-center gap-2">
        <select
          value={state.addKind}
          disabled={disabled || submitting}
          onChange={(e) => {
            setState({ ...INITIAL, addKind: e.target.value as DocumentSourceKind });
            setConsent(false);
          }}
          className="px-2 py-1.5 rounded-md bg-surface-2 border border-border text-xs text-fg"
        >
          {KIND_OPTIONS.map((o) => {
            const integration = integrationForSourceKind(o.value);
            const unavailable = integration !== null && !configuredIntegrations.includes(integration);
            return <option key={o.value} value={o.value} disabled={unavailable}>{o.label}{unavailable ? " (connect credentials first)" : ""}</option>;
          })}
        </select>
        <span className="text-[11px] text-fg-faint">{kindHint(state.addKind)}</span>
      </div>

      <label className="flex items-start gap-2 text-xs text-fg-muted">
        <input type="checkbox" checked={consent} disabled={disabled || submitting || localEmbeddings === null}
          onChange={(e) => setConsent(e.target.checked)} />
        Index this source and make its content available to assistant document search, subject to global exclusions.
        Retrieved excerpts may be sent to the configured chat provider.
      </label>
      {localEmbeddings === false && (
        <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">
          The embedding provider is not Jarela Local. Content may leave this device during indexing.
          Recall exclusions do not prevent embedding or storage.
        </p>
      )}
      {state.addKind === "local_folder"
        ? <LocalFolderFields {...fieldProps} onOpenPicker={() => setPickerOpen(true)} />
        : <RemoteSourceFields {...fieldProps} />}

      {pickerOpen && (
        <FolderPickerDialog
          initialPath={state.addPath.trim() || undefined}
          onClose={() => setPickerOpen(false)}
          onSelect={(picked) => {
            set("addPath", picked);
            setPickerOpen(false);
          }}
        />
      )}
    </section>
  );
}
