// Barrel of built-in tool modules. Each side-effect import triggers the
// module's `registerLangChainPackage(...)` call (see ./langchain-package.ts).
// Adding a new built-in tool: add the file under lib/tools/ and append a
// line here.
//
// Order matters only for deterministic logging / UI ordering — registry
// preserves insertion order.

import "./memory";
import "./documents";
import "./exec";
import "./filesystem/files";
import "./filesystem/files-search";
import "./filesystem/workspace";
import "./web/search";
import "./web/fetch";
import "./web/shopping";
import "./location";
import "./web/generate_image";
import "./web/generate_voice";
import "./schedule";
import "./watcher";
import "./system/propose";
import "./system/agent-instruction";
import "./system/integrations";
import "./workflow-progress";
// Default LangChain packages (Atlassian, GitHub, Jira Align) ship with
// Jarela but are runtime-toggleable: see ./default-packages.ts.
import { registerDefaultPackages } from "./packages/default-packages";
// Skip during `next build` page-data collection: parallel workers would
// race on the SQLite migration lock when isPackageDisabled() opens the DB.
// The real server boot path still imports this barrel and runs the call.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  registerDefaultPackages();
}
import "./communications/gmail";
import "./communications/calendar";
import "./communications/outlook";
import "./communications/outlook-calendar";
import "./communications/ms-todo";
import "./communications/ms-graph";
import "./delegation/delegate";
import "./system/system_config";
import "./system/list-tools";
import "./system/invoke-tool";
import "./system/providers-info";
import "./system/mcp-servers-info";
import "./extension-surfaces";
import "./system/harness-info";
import "./async-results-tool";
import "./system/tool-telemetry-issue";
import "./web/browser-control";
import "./system/skills";
import "./terminal";
import "./delegation/claude-delegate";
import "./delegation/codex-delegate";
