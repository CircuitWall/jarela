export const TABS = [
  "chat",
  "dashboard",
  "agents",
  "memory",
  "documents",
  "models",
  "credentials",
  "mcp",
  "extensions",
  "tools",
  "tasks",
  "bridges",
  "profile",
  "harness",
  "logs",
  "env",
  "settings",
] as const;

export type Tab = (typeof TABS)[number];
