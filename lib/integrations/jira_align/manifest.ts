import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const jiraAlignManifest: IntegrationManifest = {
  id: "jira_align",
  name: "Jira Align",
  summary:
    "Lets the agent search and modify Jira Align work items (epics, capabilities, features, " +
    "stories, themes, tasks, defects, objectives), walk the program / team / release / sprint / " +
    "portfolio / value-stream hierarchy, manage comments and dependencies, and create or edit " +
    "hierarchy entities. Different surface from Jira Cloud — this is the portfolio-level product. " +
    "Authenticates with a bearer API token tied to a personal access token in Jira Align.",
  category: "issue-tracker",
  prerequisites: [
    {
      check: "credentials",
      detail:
        "A Jira Align account on your instance (typically https://<your-company>.jiraalign.com) " +
        "with permission to view (and modify, if you want write tools enabled) the work items, " +
        "programs, and teams the agent should reach.",
    },
    {
      check: "credentials",
      detail:
        "A personal access token created in Jira Align under Settings → Personal Access Tokens. " +
        "Jira Align uses bearer auth — there is no email + token pairing like Jira Cloud.",
    },
  ],
  steps: [
    {
      id: "create-token",
      title: "Create a Jira Align personal access token",
      description:
        "Open your Jira Align instance, click the gear menu → Settings → Personal Access Tokens, " +
        "click New Token, give it a label like 'Jarela', set an expiry, and copy the token. The " +
        "token is shown once — copy it before closing the dialog.",
    },
    {
      id: "save-credentials",
      title: "Save the credentials in Jarela",
      description:
        "Propose enabling the integration. The user will be asked for the instance URL and the " +
        "API token. The token is stored encrypted at rest. Verify with a read-only call such as " +
        "jira_align_list_entities (entity_type='program') to confirm the token works before " +
        "exercising any write tools.",
      proposes: "enable_integration",
      verify: {
        tool: "jira_align_list_entities",
        args: { entity_type: "program", max_results: 1 },
      },
    },
    {
      id: "review-write-permissions",
      title: "Optional: scope write access in the AgentEditor",
      description:
        "Jira Align tools are split by capability (read / write / execute) so the user can flip " +
        "groups independently. By default the agent should be configured read-only. Only enable " +
        "the write tools (jira_align_create_*, jira_align_update_*, jira_align_delete_*, " +
        "jira_align_add_comment, jira_align_create_dependency, …) once the user has confirmed " +
        "they want the agent to mutate items. Delete tools require an explicit `confirm` arg per " +
        "call as a second guard against accidental destruction.",
    },
  ],
  troubleshooting: [
    {
      when: "tool returns 401 Unauthorized",
      say:
        "The bearer token is wrong, expired, or was revoked. Ask the user to regenerate the token " +
        "in Jira Align under Settings → Personal Access Tokens and re-enter it in the Integrations panel.",
    },
    {
      when: "tool returns 403 Forbidden on a specific item or entity",
      say:
        "The account doesn't have permission for that resource. Either the program/team isn't in " +
        "the user's portfolio or the item is restricted by workflow. Ask the user to verify " +
        "access in the Jira Align web UI.",
    },
    {
      when: "tool returns 404 on a known item id",
      say:
        "Jira Align v2 has no generic /items collection — every item lives under its type-specific " +
        "collection (/epics, /features, /stories, …). Make sure the `type` argument matches the " +
        "item's actual type. If it does, the item may have been deleted or moved to a portfolio " +
        "the user can't see.",
    },
    {
      when: "endpoint shape doesn't match what the tool expects",
      say:
        "Field names and sub-resource paths vary across Jira Align versions and editions. The " +
        "authoritative reference is the instance's own Swagger at " +
        "<instance>.jiraalign.com/rest/align/api/docs/. Ask the user to share the exact field " +
        "names from that page if a write call rejects a field.",
    },
  ],
};
