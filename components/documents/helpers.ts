import type { DocumentSource, DocumentSourceKind } from "@/api/types";

export const KIND_OPTIONS: Array<{ value: DocumentSourceKind; label: string }> = [
  { value: "local_folder", label: "Local folder" },
  { value: "jira_project", label: "Jira project" },
  { value: "jira_jql", label: "Jira JQL" },
  { value: "confluence_space", label: "Confluence space" },
  { value: "confluence_cql", label: "Confluence CQL" },
  { value: "github_pulls", label: "GitHub pull requests" },
  { value: "github_repo", label: "GitHub repo files" },
  { value: "gmail_mail", label: "Gmail mail" },
  { value: "outlook_mail", label: "Outlook mail" },
];

export function isGithubKind(k: DocumentSourceKind): boolean {
  return k === "github_pulls" || k === "github_repo";
}

export function isMailKind(k: DocumentSourceKind): boolean {
  return k === "gmail_mail" || k === "outlook_mail";
}

export function summarizeRemote(s: DocumentSource): string {
  const c = s.config ?? {};
  switch (s.kind) {
    case "jira_project":     return `Jira project: ${String(c.project_key ?? "?")}`;
    case "jira_jql":         return `Jira JQL: ${String(c.jql ?? "?")}`;
    case "confluence_space": return `Confluence space: ${String(c.space_key ?? "?")}`;
    case "confluence_cql":   return `Confluence CQL: ${String(c.cql ?? "?")}`;
    case "github_pulls": {
      const slug = `${String(c.owner ?? "?")}/${String(c.repo ?? "?")}`;
      return `GitHub PRs: ${slug}`;
    }
    case "github_repo": {
      const slug = `${String(c.owner ?? "?")}/${String(c.repo ?? "?")}`;
      const ref = c.ref ? `@${String(c.ref)}` : "";
      const prefix = c.path_prefix ? ` /${String(c.path_prefix).replace(/^\/+|\/+$/g, "")}` : "";
      return `GitHub repo: ${slug}${ref}${prefix}`;
    }
    case "gmail_mail":       return `Gmail: ${String(c.query ?? "?")}`;
    case "outlook_mail":     return `Outlook: ${String(c.query ?? "?")}`;
    default:                 return s.path;
  }
}
