// Barrel of built-in tool modules. Each side-effect import triggers the
// module's `registerLangChainPackage(...)` call (see ../packages/langchain-package.ts).
// Adding a new built-in tool: add the file under lib/tools/ and append a
// line here.
//
// Order matters only for deterministic logging / UI ordering â€” registry
// preserves insertion order.

import "../general/memory";
import "../general/documents";
import "../general/exec";
import "../filesystem/files";
import "../filesystem/files-search";
import "../filesystem/workspace";
import "../web/search";
import "../web/fetch";
import "../web/shopping";
import "../general/location";
import "../web/generate_image";
import "../web/generate_voice";
import "../general/schedule";
import "../general/watcher";
import "../system/propose";
import "../system/agent-instruction";
import "../system/integrations";
import "../general/workflow-progress";
// Default LangChain packages (Atlassian, GitHub, Jira Align) ship with
// Jarela but are runtime-toggleable: see ./default-packages.ts.
import { registerDefaultPackages } from "../packages/default-packages";
// Skip during `next build` page-data collection: parallel workers would
// race on the SQLite migration lock when isPackageDisabled() opens the DB.
// The real server boot path still imports this barrel and runs the call.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  registerDefaultPackages();
}
import "../communications/gmail";
import "../communications/calendar";
import "../communications/outlook";
import "../communications/outlook-calendar";
import "../communications/ms-todo";
import "../communications/ms-graph";
import "../delegation/delegate";
import "../system/system_config";
import "../system/list-tools";
import "../system/invoke-tool";
import "../system/providers-info";
import "../system/mcp-servers-info";
import "../general/extension-surfaces";
import "../system/harness-info";
import "../support/async-results-tool";
import "../system/tool-telemetry-issue";
import "../web/browser-control";
import "../system/skills";
import "../general/terminal";
import "../delegation/claude-delegate";
import "../delegation/codex-delegate";
