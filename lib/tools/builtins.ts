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
import "./location";
import "./generate_image";
import "./generate_voice";
import "./schedule";
import "./watcher";
import "./propose";
import "./integrations";
// Consolidated wiring for @circuitwall/{atlassian,github,jira-align}-langchain.
// Replaces the per-package adapter files (atlassian.ts, github.ts, jira-align.ts).
import "./builtin-langchain-packages";
import "./gmail";
import "./calendar";
import "./outlook";
import "./outlook-calendar";
import "./delegate";
import "./system_config";
import "./list-tools";
import "./providers-info";
import "./mcp-servers-info";
import "./extension-surfaces";
import "./async-results-tool";
import "./browser-control";
