---
status: accepted
date: 2026-10-08
---

# Tool binding budget with deferred tool definitions

## Context

Every pinned tool was bound with its full JSON definition on every model call. The provider cap (128 for OpenAI-compatible APIs) was the only limit. An agent with all tools selected paid roughly 14k tokens of definitions on each step of a tool loop, even when it used about 8 tools. A scheduled agent measured at 280k to 570k input tokens per run, most of it unused definitions resent on every step.

`list_tools` (search, optionally with schemas) and `invoke_tool` (call by name) already exist, and unbound tools already surface as `permission_reason=proxy_only`. Claude Code solves the same problem by deferring tool definitions and listing only names.

## Decision

Add `JARELA_TOOL_BIND_BUDGET` (default 40, 0 disables). After hot-loading and before the provider cap, trim the bound set to the budget in this order:

1. Self-configuration tools and the result-reading tools (`tool_result_get`, `tool_result_list`).
2. Tools this agent called recently in its thread, most recent first, including targets reached through `invoke_tool`.
3. The agent's own pinned tools in their configured order.
4. The remaining basic default tools in catalog order.

Trimmed tools stay permitted. They get `permission_reason=proxy_only`, and their names (capped at 150, no definitions) are listed in the per-turn tool block so the agent can go straight to `list_tools names=[...] include_schema=true` and then `invoke_tool`.

The trimmed list keeps its input order and does not depend on the current message, so the tool block stays byte-stable between turns and the provider prompt cache holds. Message-relevance scoring stays only in the provider-cap path, where it already applied.

## Consequences

* Good: agents with large pinned lists stop paying for unused definitions on every step.
* Good: nothing is denied. Permissions are unchanged; only how a tool is reached changes.
* Bad: the first use of a not-yet-used tool costs an extra `list_tools` and `invoke_tool` round trip, and models may handle `args_json` less reliably than native tool calls. Behaviour needs live checks on each provider.
* Bad: the shared prompt prefix changes once (SOP step 2), which invalidates the shared cache one time.

## More Information

The recency signal reads the thread's persisted tool events, so an agent keeps its working set as it runs. A per-agent usage table would be more precise but needs a schema change and was not needed.
