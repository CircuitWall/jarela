/**
 * Native Atlassian tools (Jira + Confluence) — direct REST API calls, no MCP.
 *
 * Why this exists: corporate networks often block public PyPI/npm, which makes
 * the `mcp-atlassian` install path fragile. These tools just hit the Atlassian
 * REST API over HTTPS, which goes through the same proxy (EnvHttpProxyAgent)
 * the rest of the server uses — so they work anywhere a browser can reach
 * `*.atlassian.net`.
 *
 * Auth resolution (in priority order):
 *   1. Env: ATLASSIAN_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN
 *   2. Memory store: namespace="integrations", key="atlassian", value=
 *        { url, email, api_token }
 *
 * The agent can populate option 2 via memory_write if the user shares the
 * credentials in chat — but most users will set env vars at server boot.
 *
 * SHAPE: This file used to be a 3130-line monolith. It's now a thin entry
 * point that:
 *   1. Re-exports the public surface (auth helpers, every tool, every
 *      pure helper used by tests / sibling modules).
 *   2. Calls registerTools to declare the read + write capability sets.
 * The actual code lives under lib/tools/atlassian/. See ADR-0055 for the
 * split rationale and the layer breakdown.
 */
import { registerTools } from "./registry";

// Auth + fetch (sibling-module accessors live here).
export type { AtlassianAuth } from "./atlassian/_auth";
export { _resolveAtlassianAuth, _atlassianFetch } from "./atlassian/_auth";

// Pure helpers — exported for unit tests + sibling indexers.
export {
  confluenceTextToStorage,
  parseV2NextCursor,
  resolveCustomFieldNames,
  extractFieldValue,
  type JiraFieldDef,
} from "./atlassian/_helpers";

// Jira issue tools.
import {
  jiraSearchTool,
  jiraGetIssueTool,
  jiraCreateIssueTool,
  jiraAddCommentTool,
  jiraFindUserTool,
  jiraUpdateIssueTool,
  jiraTransitionsTool,
  jiraLinkIssuesTool,
  jiraCreateIssuesBulkTool,
  jiraAddRemoteLinkTool,
  jiraDeleteLinkTool,
  jiraUploadAttachmentTool,
  jiraDeleteIssueTool,
} from "./atlassian/jira";
export {
  jiraSearchTool,
  jiraGetIssueTool,
  jiraCreateIssueTool,
  jiraAddCommentTool,
  jiraFindUserTool,
  jiraUpdateIssueTool,
  jiraTransitionsTool,
  jiraLinkIssuesTool,
  jiraCreateIssuesBulkTool,
  jiraAddRemoteLinkTool,
  jiraDeleteLinkTool,
  jiraUploadAttachmentTool,
  jiraDeleteIssueTool,
};

// Jira agile (boards / sprints).
import {
  validateSprintTransition,
  jiraListBoardsTool,
  jiraGetBoardTool,
  jiraListSprintsTool,
  jiraGetSprintTool,
  jiraCreateSprintTool,
  jiraUpdateSprintTool,
  jiraDeleteSprintTool,
  jiraMoveIssuesToSprintTool,
  jiraMoveIssuesToBacklogTool,
  jiraRankIssuesTool,
} from "./atlassian/jira-agile";
export {
  validateSprintTransition,
  jiraListBoardsTool,
  jiraGetBoardTool,
  jiraListSprintsTool,
  jiraGetSprintTool,
  jiraCreateSprintTool,
  jiraUpdateSprintTool,
  jiraDeleteSprintTool,
  jiraMoveIssuesToSprintTool,
  jiraMoveIssuesToBacklogTool,
  jiraRankIssuesTool,
};

// Jira extras (comments CRUD / worklogs / attachments / changelog).
import {
  jiraGetCommentsTool,
  jiraUpdateCommentTool,
  jiraDeleteCommentTool,
  jiraGetAttachmentContentTool,
  jiraDeleteAttachmentTool,
  jiraAddWorklogTool,
  jiraListWorklogsTool,
  jiraGetChangelogTool,
} from "./atlassian/jira-extras";
export {
  jiraGetCommentsTool,
  jiraUpdateCommentTool,
  jiraDeleteCommentTool,
  jiraGetAttachmentContentTool,
  jiraDeleteAttachmentTool,
  jiraAddWorklogTool,
  jiraListWorklogsTool,
  jiraGetChangelogTool,
};

// Jira project metadata.
import {
  jiraListProjectsTool,
  jiraGetProjectTool,
  jiraListVersionsTool,
  jiraCreateVersionTool,
  jiraUpdateVersionTool,
  jiraListComponentsTool,
  jiraCreateComponentTool,
  jiraListMetaTool,
} from "./atlassian/jira-meta";
export {
  jiraListProjectsTool,
  jiraGetProjectTool,
  jiraListVersionsTool,
  jiraCreateVersionTool,
  jiraUpdateVersionTool,
  jiraListComponentsTool,
  jiraCreateComponentTool,
  jiraListMetaTool,
};

// Confluence (read + write + v2 gap-fillers).
import {
  confluenceSearchTool,
  confluenceGetPageTool,
  confluenceGetPageByTitleTool,
  confluenceGetPageChildrenTool,
  confluenceGetPageAncestorsTool,
  confluenceListSpacesTool,
  confluenceGetCommentsTool,
  confluenceListAttachmentsTool,
  confluenceGetLabelsTool,
  confluenceGetAttachmentContentTool,
  confluenceCreatePageTool,
  confluenceUpdatePageTool,
  confluenceAddCommentTool,
  confluenceMovePageTool,
  confluenceUploadAttachmentTool,
  confluenceAddLabelTool,
  confluenceDeletePageTool,
  confluenceUpdateCommentTool,
  confluenceDeleteCommentTool,
  confluenceRemoveLabelTool,
  confluenceDeleteAttachmentTool,
} from "./atlassian/confluence";
export {
  confluenceSearchTool,
  confluenceGetPageTool,
  confluenceGetPageByTitleTool,
  confluenceGetPageChildrenTool,
  confluenceGetPageAncestorsTool,
  confluenceListSpacesTool,
  confluenceGetCommentsTool,
  confluenceListAttachmentsTool,
  confluenceGetLabelsTool,
  confluenceGetAttachmentContentTool,
  confluenceCreatePageTool,
  confluenceUpdatePageTool,
  confluenceAddCommentTool,
  confluenceMovePageTool,
  confluenceUploadAttachmentTool,
  confluenceAddLabelTool,
  confluenceDeletePageTool,
  confluenceUpdateCommentTool,
  confluenceDeleteCommentTool,
  confluenceRemoveLabelTool,
  confluenceDeleteAttachmentTool,
};

registerTools("Atlassian", "read", [
  jiraSearchTool, jiraGetIssueTool, jiraFindUserTool,
  jiraListBoardsTool, jiraGetBoardTool,
  jiraListSprintsTool, jiraGetSprintTool,
  jiraGetCommentsTool, jiraGetAttachmentContentTool,
  jiraListWorklogsTool, jiraGetChangelogTool,
  jiraListProjectsTool, jiraGetProjectTool,
  jiraListVersionsTool, jiraListComponentsTool, jiraListMetaTool,
  confluenceSearchTool, confluenceGetPageTool,
  confluenceGetPageByTitleTool, confluenceGetPageChildrenTool,
  confluenceGetPageAncestorsTool, confluenceListSpacesTool,
  confluenceGetCommentsTool, confluenceListAttachmentsTool,
  confluenceGetLabelsTool, confluenceGetAttachmentContentTool,
]);
registerTools("Atlassian", "execute", [
  jiraCreateIssueTool, jiraCreateIssuesBulkTool, jiraUpdateIssueTool,
  jiraAddCommentTool, jiraTransitionsTool,
  jiraLinkIssuesTool, jiraAddRemoteLinkTool, jiraDeleteLinkTool,
  jiraUploadAttachmentTool, jiraDeleteIssueTool,
  jiraCreateSprintTool, jiraUpdateSprintTool, jiraDeleteSprintTool,
  jiraMoveIssuesToSprintTool, jiraMoveIssuesToBacklogTool, jiraRankIssuesTool,
  jiraUpdateCommentTool, jiraDeleteCommentTool, jiraDeleteAttachmentTool,
  jiraAddWorklogTool,
  jiraCreateVersionTool, jiraUpdateVersionTool, jiraCreateComponentTool,
  confluenceCreatePageTool, confluenceUpdatePageTool,
  confluenceAddCommentTool, confluenceMovePageTool,
  confluenceUploadAttachmentTool, confluenceAddLabelTool,
  confluenceDeletePageTool, confluenceUpdateCommentTool, confluenceDeleteCommentTool,
  confluenceRemoveLabelTool, confluenceDeleteAttachmentTool,
]);
