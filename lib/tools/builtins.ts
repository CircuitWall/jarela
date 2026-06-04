// Barrel of built-in tool modules. Each side-effect import triggers the
// module's `registerTools(...)` call (see ./registry.ts). Adding a new
// built-in tool: add the file under lib/tools/ and append a line here.
//
// Order matters only for deterministic logging / UI ordering — registry
// preserves insertion order.

import "./memory";
import "./documents";
import "./exec";
import "./files";
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
import "./atlassian";
import "./jira-align";
import "./github";
import "./gmail";
import "./calendar";
import "./outlook";
import "./outlook-calendar";
import "./delegate";
import "./system_config";
