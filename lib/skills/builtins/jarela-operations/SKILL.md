# Jarela Operations

Use this skill when the user asks how to operate Jarela day to day: run it,
diagnose setup, manage credentials, handle releases, or understand where state
lives.

## Operating Model

- Jarela is a local Next.js app backed by SQLite under `JARELA_DB_DIR` or
  `~/.jarela`.
- Persistent state should go through the app APIs and stores, not ad-hoc file
  writes into the data directory.
- Agents can use typed tools for files, web, memory, documents, integrations,
  scheduling, browser control, MCP, and configuration proposals.
- No telemetry or analytics are expected. External cloud calls happen only
  through configured model, MCP, integration, or GitHub providers.

## Common Checks

1. For install/runtime problems, inspect environment and package state first:
   `JARELA_DB_DIR`, model credentials, MCP settings, proxy settings, and the
   configured default model.
2. For missing tools, call `list_tools` with a focused `query` before assuming a
   capability is unavailable.
3. For missing skills, call `list_skills`, then `read_skill` for the relevant
   skill.
4. For long conversations or context confusion, use the chat compaction control
   or the compact-current-thread tool when available.
5. For scheduled or event-driven work, distinguish `schedule_task` for clock
   time from `schedule_watcher` for changes detected by polling a built-in tool.

## Safety Rules

- Do not ask the user to paste secrets into chat. Use credential panels or
  approval UI secret fields.
- Do not mutate files inside Jarela's data directory directly.
- Prefer typed Jarela APIs/tools over shell commands when the app already has a
  tool for the operation.
- For destructive actions, confirm the target and effect unless the user has
  already explicitly authorized it.

## Useful Surfaces

- Credentials: model providers, integrations, bridge/API credentials.
- Models: model config rows, default model, router settings, context budgets.
- Agents: identity, instructions, allowed tools, harness, delegates, history
  window, citation strictness, voice settings.
- Tools: built-ins, drop-in tools, LangChain packages, MCP tools.
- Skills: packaged built-ins plus user skills from `JARELA_SKILLS_DIR`.
- Documents: local/remote sources, embedding settings, reindexing.
- Tasks: scheduled tasks, watchers, reaction scripts.
