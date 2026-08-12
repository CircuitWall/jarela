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
import "./files";
import "./files-search";
import "./workspace";
import "./search";
import "./fetch";
import "./shopping";
import "./location";
import "./generate_image";
import "./generate_voice";
import "./schedule";
import "./watcher";
import "./propose";
import "./integrations";
// Default LangChain packages (Atlassian, GitHub, Jira Align) ship with
// Jarela but are runtime-toggleable: see ./default-packages.ts.
import { registerDefaultPackages } from "./default-packages";
// Skip during `next build` page-data collection: parallel workers would
// race on the SQLite migration lock when isPackageDisabled() opens the DB.
// The real server boot path still imports this barrel and runs the call.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  registerDefaultPackages();
}
import "./gmail";
import "./calendar";
import "./outlook";
import "./outlook-calendar";
import "./ms-todo";
import "./ms-graph";
import "./delegate";
import "./system_config";
import "./list-tools";
import "./providers-info";
import "./mcp-servers-info";
import "./extension-surfaces";
import "./async-results-tool";
import "./browser-control";
import "./skills";
import "./terminal";
import "./claude-delegate";
