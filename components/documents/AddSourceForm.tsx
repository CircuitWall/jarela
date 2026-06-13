"use client";
import { useState } from "react";
import type { api } from "@/api/client";
import type { DocumentSourceKind } from "@/api/types";
import { FolderPickerDialog } from "./FolderPickerDialog";
import { KIND_OPTIONS, isGithubKind, isMailKind } from "./helpers";
import {
  LocalFolderFields,
  RemoteSourceFields,
  makeSetField,
  type FormState,
} from "./AddSourceFields";

type CreatePayload = Parameters<typeof api.documents.createSource>[0];

interface Props {
  disabled: boolean;
  onSubmit: (payload: CreatePayload) => Promise<void>;
}

const INITIAL: FormState = {
  addKind: "local_folder",
  addPath: "",
  addLabel: "",
  addProjectKey: "",
  addSpaceKey: "",
  addQuery: "",
  addMailQuery: "",
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
    const v = s.addMailQuery.trim();
    if (!v) return null;
    config.query = v;
    const maxResults = parseInt(s.addMailMaxResults, 10);
    if (Number.isFinite(maxResults) && maxResults > 0) config.max_results = maxResults;
    const pageSize = parseInt(s.addMailPageSize, 10);
    if (Number.isFinite(pageSize) && pageSize > 0) config.page_size = pageSize;
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
  if (isGithubKind(kind)) return "Requires GitHub credentials (Credentials → GitHub).";
  return "Requires Atlassian credentials (Credentials → Atlassian).";
}

export function AddSourceForm({ disabled, onSubmit }: Props) {
  const [state, setState] = useState<FormState>(INITIAL);
  const [pickerOpen, setPickerOpen] = useState(false);
  const set = makeSetField(setState);
  const payload = buildPayload(state);

  async function handleSubmit() {
    if (!payload) return;
    try {
      await onSubmit(payload);
      setState({ ...INITIAL, addKind: state.addKind });
    } catch {
      // parent surfaces the error; keep form state for retry.
    }
  }

  const fieldProps = {
    state,
    set,
    disabled,
    canSubmit: payload !== null,
    onSubmit: () => void handleSubmit(),
  };

  return (
    <section className="space-y-2">
      <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Add a source</label>
      <div className="flex items-center gap-2">
        <select
          value={state.addKind}
          onChange={(e) => setState({ ...INITIAL, addKind: e.target.value as DocumentSourceKind })}
          className="px-2 py-1.5 rounded-md bg-surface-2 border border-border text-xs text-fg"
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span className="text-[11px] text-fg-faint">{kindHint(state.addKind)}</span>
      </div>

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
