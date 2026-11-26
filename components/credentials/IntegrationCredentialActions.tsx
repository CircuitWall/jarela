"use client";
import { ExternalLink, Link as LinkIcon, Loader2, Star, Trash2 } from "lucide-react";
import type { IntegrationDefinition, IntegrationStatus } from "@/api/types";
import type { CredentialEditorMode, useIntegrationCredential } from "@/hooks/useIntegrationCredential";
import type { useIntegrationOAuth } from "@/hooks/useIntegrationOAuth";

type OAuthProvider = "gmail" | "outlook" | "atlassian";

export function IntegrationCredentialActions({
  definition: def, status, mode, editor, oauth, disableTesting,
}: {
  definition: IntegrationDefinition;
  status?: IntegrationStatus;
  mode: CredentialEditorMode;
  editor: Pick<ReturnType<typeof useIntegrationCredential>, "state" | "commands">;
  oauth: Pick<ReturnType<typeof useIntegrationOAuth>, "state" | "commands">;
  disableTesting: boolean;
}) {
  const { saving, testing } = editor.state;
  const { save, test, remove, promoteToDefault } = editor.commands;
  const { connecting } = oauth.state;
  const credential = mode.kind === "edit" ? mode.credential : null;
  const configured = mode.kind !== "default" || status?.configured;
  const creating = mode.kind === "create";
  // Map integration names to OAuth provider keys used by the OAuth hook.
  // An integration supports OAuth if def.auth_method === "oauth".
  const oauthNameMap: Record<string, OAuthProvider> = {
    gmail: "gmail",
    outlook: "outlook",
    "Atlassian (Jira + Confluence)": "atlassian",
  };
  const oauthProvider = def.auth_method === "oauth" ? (oauthNameMap[def.name] ?? null) : null;
  const oauthLabel = oauthProvider === "gmail" ? "Gmail"
    : oauthProvider === "outlook" ? "Outlook"
    : oauthProvider === "atlassian" ? "Atlassian"
    : null;

  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-2 border-t border-border bg-surface-2/95 px-1 py-2 backdrop-blur">
      <button onClick={save} disabled={saving}
        className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
        {saving ? "Saving…" : creating ? "Create" : "Save"}
      </button>
      <button onClick={test} disabled={testing || !configured || disableTesting}
        title={!configured ? "Save credentials first" : disableTesting ? "Save before testing" : credential ? "Test this credential" : "Test the connection"}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed">
        {testing ? <Loader2 size={11} className="animate-spin" /> : <ExternalLink size={11} />}
        Test
      </button>
      {oauthProvider && (
        <button onClick={() => oauth.commands.connectOAuth(oauthProvider)} disabled={connecting || creating}
          title={creating
            ? `Save this credential first, then connect ${oauthLabel}`
            : {
                gmail: "Authorize Gmail + Calendar via Google OAuth — opens a browser window",
                outlook: "Authorize Outlook + Calendar via Microsoft OAuth — opens a browser window",
                atlassian: "Authorize Atlassian (Jira + Confluence) via Atlassian OAuth — opens a browser window",
              }[oauthProvider]}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed">
          {connecting ? <Loader2 size={11} className="animate-spin" /> : <LinkIcon size={11} />}
          {connecting ? "Waiting…" : `Connect ${oauthLabel}`}
        </button>
      )}
      {credential && !credential.is_default && (
        <button onClick={promoteToDefault}
          className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-fg-muted hover:text-fg"
          title="Promote this credential to be the default for this provider">
          <Star size={11} /> Set default
        </button>
      )}
      {configured && !creating && (
        <button onClick={remove}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1.5 text-xs text-fg-faint hover:text-rose-700 dark:hover:text-rose-400"
          title={credential ? "Delete this credential" : "Remove saved credentials"}>
          <Trash2 size={11} /> {credential ? "Delete" : "Clear"}
        </button>
      )}
    </div>
  );
}
