// Preserve existing v1 wording, including legacy capitalization.
export const NOT_FOUND_ERRORS = {
  DEFAULT: "Not found",
  LEGACY: "not found",
  AGENT: "Agent not found",
  AGENT_LEGACY: "agent not found",
  THREAD: "Thread not found",
  CREDENTIAL: "credential not found",
  TOOL: "tool not found",
  HOST: "host not found",
  HARNESS: "Harness not found",
  MCP_SERVER: "MCP server not found",
  RESTART_THREAD: "Restart thread not found",
  MESSAGE_IN_THREAD: "Message not found in thread",
} as const;
