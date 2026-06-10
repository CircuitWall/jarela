"use client";
import { FolderOpen, Plus } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { DocumentSourceKind } from "@/api/types";
import { isGithubKind, isMailKind } from "./helpers";

export interface FormState {
  addKind: DocumentSourceKind;
  addPath: string;
  addLabel: string;
  addProjectKey: string;
  addSpaceKey: string;
  addQuery: string;
  addMailQuery: string;
  addMailMaxResults: string;
  addMailPageSize: string;
  addRecencyDays: string;
  addGhOwner: string;
  addGhRepo: string;
  addGhRef: string;
  addGhPathPrefix: string;
  addGhState: "all" | "open" | "closed";
}

export type SetField = <K extends keyof FormState>(k: K, v: FormState[K]) => void;

interface FieldsProps {
  state: FormState;
  set: SetField;
  disabled: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  onOpenPicker?: () => void;
}

export function LocalFolderFields(props: FieldsProps) {
  const { state, set, disabled, canSubmit, onSubmit, onOpenPicker } = props;
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <div className="flex flex-1 min-w-0 gap-1">
        <input
          type="text"
          value={state.addPath}
          onChange={(e) => set("addPath", e.target.value)}
          placeholder="Pick or paste an absolute path"
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
        />
        <button
          type="button"
          onClick={onOpenPicker}
          title="Browse for a folder"
          className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-surface-3 border border-border text-xs text-fg hover:bg-surface-2 transition-colors"
        >
          <FolderOpen size={13} /> Browse
        </button>
      </div>
      <input
        type="text"
        value={state.addLabel}
        onChange={(e) => set("addLabel", e.target.value)}
        placeholder="Label (optional)"
        className="sm:w-40 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
      />
      <SubmitButton disabled={disabled || !canSubmit} onClick={onSubmit} />
    </div>
  );
}

export function RemoteSourceFields(props: FieldsProps) {
  return (
    <div className="space-y-2">
      <RemoteKindInputs state={props.state} set={props.set} />
      <RemoteLabelRow {...props} />
    </div>
  );
}

function RemoteKindInputs({ state, set }: { state: FormState; set: SetField }) {
  return (
    <>
      {state.addKind === "jira_project" && (
        <input
          type="text"
          value={state.addProjectKey}
          onChange={(e) => set("addProjectKey", e.target.value)}
          placeholder='Project key (e.g. "ACME")'
          className="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
        />
      )}
      {state.addKind === "confluence_space" && (
        <input
          type="text"
          value={state.addSpaceKey}
          onChange={(e) => set("addSpaceKey", e.target.value)}
          placeholder='Space key (e.g. "ENG")'
          className="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
        />
      )}
      {(state.addKind === "jira_jql" || state.addKind === "confluence_cql") && (
        <textarea
          value={state.addQuery}
          onChange={(e) => set("addQuery", e.target.value)}
          placeholder={
            state.addKind === "jira_jql"
              ? 'JQL — e.g. assignee = currentUser() AND resolution = Unresolved'
              : 'CQL — e.g. label = onboarding'
          }
          rows={2}
          className="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono resize-y"
        />
      )}
      {isMailKind(state.addKind) && (
        <textarea
          value={state.addMailQuery}
          onChange={(e) => set("addMailQuery", e.target.value)}
          placeholder={
            state.addKind === "gmail_mail"
              ? 'Gmail query — e.g. is:unread newer_than:7d'
              : 'KQL — e.g. isRead:false received>=2026-05-01'
          }
          rows={2}
          className="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono resize-y"
        />
      )}
      {isGithubKind(state.addKind) && <GithubOwnerRepoInputs state={state} set={set} />}
      {state.addKind === "github_pulls" && (
        <select
          value={state.addGhState}
          onChange={(e) => set("addGhState", e.target.value as FormState["addGhState"])}
          className="w-full sm:w-44 px-2 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
          title="Which PRs to index"
        >
          <option value="all">All PRs</option>
          <option value="open">Open PRs only</option>
          <option value="closed">Closed PRs only</option>
        </select>
      )}
      {state.addKind === "github_repo" && <GithubRepoExtras state={state} set={set} />}
    </>
  );
}

function GithubOwnerRepoInputs({ state, set }: { state: FormState; set: SetField }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <input
        type="text"
        value={state.addGhOwner}
        onChange={(e) => set("addGhOwner", e.target.value)}
        placeholder='Owner (e.g. "octocat")'
        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
      />
      <input
        type="text"
        value={state.addGhRepo}
        onChange={(e) => set("addGhRepo", e.target.value)}
        placeholder='Repo (e.g. "hello-world")'
        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
      />
    </div>
  );
}

function GithubRepoExtras({ state, set }: { state: FormState; set: SetField }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <input
        type="text"
        value={state.addGhRef}
        onChange={(e) => set("addGhRef", e.target.value)}
        placeholder="Ref (optional, default branch)"
        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
      />
      <input
        type="text"
        value={state.addGhPathPrefix}
        onChange={(e) => set("addGhPathPrefix", e.target.value)}
        placeholder="Path prefix (optional, e.g. docs)"
        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
      />
    </div>
  );
}

function RemoteLabelRow({ state, set, disabled, canSubmit, onSubmit }: FieldsProps) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <input
        type="text"
        value={state.addLabel}
        onChange={(e) => set("addLabel", e.target.value)}
        placeholder="Label (required)"
        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
      />
      {isMailKind(state.addKind) ? (
        <>
          <input
            type="number"
            min={1}
            value={state.addMailMaxResults}
            onChange={(e) => set("addMailMaxResults", e.target.value)}
            placeholder="Max results (optional)"
            className="sm:w-44 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
          />
          <input
            type="number"
            min={1}
            value={state.addMailPageSize}
            onChange={(e) => set("addMailPageSize", e.target.value)}
            placeholder="Page size (optional)"
            className="sm:w-40 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
          />
        </>
      ) : (
        <input
          type="number"
          min={1}
          value={state.addRecencyDays}
          onChange={(e) => set("addRecencyDays", e.target.value)}
          placeholder="Recency days (optional)"
          className="sm:w-44 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
        />
      )}
      <SubmitButton disabled={disabled || !canSubmit} onClick={onSubmit} />
    </div>
  );
}

function SubmitButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors"
    >
      <Plus size={13} /> Add
    </button>
  );
}

// Hook helper so the form parent doesn't need to remember the SetState shape.
export function makeSetField(setState: Dispatch<SetStateAction<FormState>>): SetField {
  return (k, v) => setState((prev) => ({ ...prev, [k]: v }));
}
