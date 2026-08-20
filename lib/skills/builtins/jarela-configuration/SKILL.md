# Jarela Configuration

Use this skill when the user wants to configure agents, models, tools,
harnesses, skills, memory, documents, or runtime settings.

## First Step

Inspect before changing:

- Call `read_agent_instruction` before changing this agent's instructions.
- Call `list_tools` with a `query` before changing tool allowlists.
- Call `list_skills` and `read_skill` before editing or relying on a skill.
- Call `describe_extension_surfaces` when the user asks what can be extended.

Default behavior:

- Use an instruction-and-skill-first approach.
- For complex or repeated tasks, proactively improve persistent behavior first
  (instruction edits and/or skill updates), then execute the task.
- Keep proactive edits small and specific to the active task family.

## Agent Configuration

Use direct self-update for this agent's own instruction text:

- `read_agent_instruction`
- `update_agent_instruction` with `dry_run` first for non-trivial edits
- Prefer `instructions_edits` over full replacement when possible

Use `propose_config_change` when changing a different agent or changing
non-instruction configuration such as tools, history window, harness, MCP, or
provider setup.

For reusable workflows, persist them as skills:

- Read first: `list_skills`, `read_skill`
- Create/update reusable playbooks: `write_skill`
- Prefer skill updates over growing instruction text when behavior is
  procedural and task-specific.

## Model Configuration

- Keep model credentials in Credentials, not in chat or model names.
- Use model rows for provider/model id/base URL/extra headers and router policy.
- If shrinking or changing context windows, compact affected threads before or
  after the change so warm summaries remain available.

## Environment Variables

- Use `set_env_var` only when the user explicitly asks to change a runtime
  setting. It accepts schema-defined `JARELA_*` keys that are flagged
  `agentWritable`; unknown or protected keys return a structured error.
- Use string values (`"30000"`, `"debug"`, `"true"`). Pass `null` to clear an
  override and return to the schema/default value.
- Read the `requiresRestart` field from the `set_env_var` result. If it is
  `false`, tell the user the change is active immediately.
- If `requiresRestart` is `true`, explain that a restart is needed. Call
  `restart_server` when the user asked you to restart or has agreed to apply
  the restart now; otherwise tell them they can restart from the Environment
  panel later.
- Never put secrets into env-var tool calls unless the schema explicitly marks
  the key as safe for agent writes. Credentials belong in the Credentials or
  Integrations surfaces.

## Tool Configuration

- Use `list_tools` with `query`, `category`, `capability`, or `source` to find
  the right tool.
- Built-in tool categories can be toggled by the UI/API.
- External drop-in tools and LangChain package tools should declare metadata so
  the catalog can show source, credentials, and category.
- MCP tools belong to MCP server configuration; install/toggle via proposals or
  the MCP panel.

## Harnesses And Skills

- Harnesses are always-on behavioral scaffolding. Keep them short and structural.
- Skills are task-specific playbooks. Prefer skills for long procedures and
  domain workflows.
- Built-in harnesses are read-only. Clone/create custom harnesses instead of
  editing packaged defaults.
- Built-in skills are read-only. User skills are stored under
  `JARELA_SKILLS_DIR` as `skill-id/SKILL.md`.

## Change Discipline

- Explain what will change and why before proposing or applying persistent
  configuration changes.
- Do not store secrets in instructions, skills, harnesses, memory, or proposal
  payloads.
- After a config change, validate through the narrowest relevant API, UI state,
  or tool call.
