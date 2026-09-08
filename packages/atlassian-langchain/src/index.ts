import {
  jiraReadTools,
  jiraWriteTools,
  jiraExecuteTools,
} from "./jira-tools";
import {
  confluenceReadTools,
  confluenceWriteTools,
  confluenceExecuteTools,
} from "./confluence-tools";

export {
  setAuthResolver,
  resolveAtlassianAuthFromEnv,
  resolveAuth,
  type AtlassianAuth,
  type AuthResolver,
  atlassianFetch,
} from "./shared";

export {
  jiraSearchTool,
  jiraGetIssueTool,
  jiraCreateIssueTool,
  jiraAddCommentTool,
  jiraFindUserTool,
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
  jiraGetCommentsTool,
  jiraUpdateCommentTool,
  jiraDeleteCommentTool,
  jiraGetAttachmentContentTool,
  jiraDeleteAttachmentTool,
  jiraListWorklogsTool,
  jiraAddWorklogTool,
  jiraGetChangelogTool,
  jiraListProjectsTool,
  jiraGetProjectTool,
  jiraListVersionsTool,
  jiraCreateVersionTool,
  jiraUpdateVersionTool,
  jiraListComponentsTool,
  jiraCreateComponentTool,
  jiraListMetaTool,
  jiraTransitionsTool,
  jiraLinkIssuesTool,
  jiraAddRemoteLinkTool,
  jiraDeleteLinkTool,
  jiraUploadAttachmentTool,
  jiraDeleteIssueTool,
  jiraCreateIssuesBulkTool,
  jiraReadTools,
  jiraWriteTools,
  jiraExecuteTools,
  jiraTools,
  validateSprintTransition,
  resolveCustomFieldNames,
  extractFieldValue,
  type JiraFieldDef,
} from "./jira-tools";

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
  confluenceReadTools,
  confluenceWriteTools,
  confluenceExecuteTools,
  confluenceTools,
  confluenceTextToStorage,
  parseV2NextCursor,
} from "./confluence-tools";

export const atlassianReadTools = [
  ...jiraReadTools,
  ...confluenceReadTools,
] as const;

export const atlassianWriteTools = [
  ...jiraWriteTools,
  ...confluenceWriteTools,
] as const;

export const atlassianExecuteTools = [
  ...jiraExecuteTools,
  ...confluenceExecuteTools,
] as const;

export const atlassianTools = [
  ...atlassianReadTools,
  ...atlassianWriteTools,
  ...atlassianExecuteTools,
] as const;