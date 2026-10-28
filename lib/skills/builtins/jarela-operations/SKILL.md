---
name: jarela-operations
description: "Use when: operating Jarela, diagnosing runtime or tool availability, locating state, scheduling work, or applying upgrades."
---

# Jarela Operations

Use this skill when the user asks how to operate Jarela day to day: run it,
diagnose setup, manage credentials, handle releases, or understand where state
lives.

## Input

The operational goal, affected installation/version, observed failure or
status and authority for changes or service interruption.

## Output

A checked operational result or explicit blocker, with partial effects,
required restart and recovery steps identified. Do not equate configuration
saved, a running process and a healthy capability.

## Validation

Use the narrowest status/read-back or health check for the expected result.
Record what was actually observed; no success claim from a command exit alone.
Stop on denied access or cancellation. For uncertain writes, inspect state
before retrying. A runtime-setting change is not approval to restart the host;
explain that restart interrupts active runs and obtain explicit agreement.
Report unavailable checks rather than inventing a healthy status.

## Operating Model

- Jarela is a local Next.js app backed by SQLite under `JARELA_DB_DIR` when
  configured; defaults are `%LOCALAPPDATA%\Jarela` on Windows and `~/.jarela`
  on macOS/Linux.
- Persistent state should go through the app APIs and stores, not ad-hoc file
  writes into the data directory.
- Agents can use typed tools for files, web, memory, documents, integrations,
  scheduling, browser control, MCP, and configuration proposals.
- No telemetry or analytics are expected. Model, MCP and integration calls use
  configured providers; permitted web/network tools can also contact sites
  needed for the user's task. Local-first does not mean every task is offline.

## Common Checks

1. For install/runtime problems, inspect environment and package state first:
   `JARELA_DB_DIR`, model credentials, MCP settings, proxy settings, and the
   configured default model. Inspect credential status, never secret values.
   Check the installed version's requirements; the current source requires
   Node 24.15.0+ within 24.x, or Node 26+. Node 25 is unsupported.
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
- Distinguish the running installation from a source checkout or test instance;
  source edits do not prove the live service loaded a change.
- Source contributions use topic branches and reviewed PRs. Publish releases
  through the repository's GitHub Actions workflow, never from this machine.

## Progress Tracking

- For complex operations with distinct execution and verification stages, use `workflow_progress` with inspect → act → verify → report. Skip simple status checks and actions that already expose sufficient native progress.
- Use one stable, task-specific `workflow_id` and include the full current
  checklist on every update. Each item needs `input`, `output` and `validation`;
  `done` requires observed `validation_evidence`. Use `needs_attention` for
  blockers and `needs_user: true` when only user input/approval can unblock them.
  Keep secrets and private data out of checklist fields.
- For scheduled prompt runs, track progress for that firing only. Script-based scheduled tasks do not run an agent and cannot call `workflow_progress`; use the Tasks panel for schedule-level state.

## Useful Surfaces

- Credentials: model providers, integrations, bridge/API credentials.
- Models: model config rows, default model, router settings, context budgets.
- Agents: identity, instructions, allowed tools, harness, delegates, history
  window, citation strictness, voice settings.
- Tools: built-ins, drop-in tools, LangChain packages, MCP tools.
- Skills: packaged built-ins plus enabled user repos managed by the Skills UI
  and `/api/v1/skills/repos`. Writes target the single writable repo, not a
  legacy environment-variable directory.
- Documents: local/remote sources, embedding settings, reindexing.
- Tasks: scheduled tasks, watchers, reaction scripts.
