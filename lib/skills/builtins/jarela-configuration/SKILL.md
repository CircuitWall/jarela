---
name: jarela-configuration
description: "Use when: inspecting or changing Jarela agent instructions, tool access, models, skills, harnesses, or runtime settings."
---

# Jarela Configuration

Use this skill when the user wants to configure agents, models, tools,
harnesses, skills, memory, documents, or runtime settings.

## Input

The requested setting, target agent/surface, current non-secret configuration
and authority for persistent changes. Read current state before drafting a
change; a skill or tool being available does not grant permission.

## Output

A scoped change and verified read-back, a pending proposal, or a specific
blocker. Distinguish saved configuration, effective runtime behavior and a
restart still required; none implies the others.

## Validation

Check tool results for errors and read the changed state back through the
relevant supported surface. A dry run is a preview, not a save; a submitted
proposal is pending, not applied. Stop on denied access or cancellation.
If a mutation's result is unknown, inspect saved state before considering a
retry. Never broaden permissions or restart the host to bypass a blocker.

## First Step

Inspect before changing:

- Call `read_agent_instruction` before changing this agent's instructions.
- Call `list_tools` with a `query` before changing tool allowlists.
- Call `list_skills` and `read_skill` before editing or relying on a skill.
- Call `describe_extension_surfaces` when the user asks what can be extended.

Default behavior:

- Use an instruction-and-skill-first approach.
- For complex or repeated tasks, identify useful instruction/skill improvements
  within the user's authorized scope; do not make unrelated persistent changes
  a prerequisite to executing the task.
- Keep any authorized proactive edits small and specific to the active task family.

## Agent Configuration

Use direct self-update for this agent's own instruction text:

- `read_agent_instruction`
- `update_agent_instruction` with `dry_run` first for non-trivial edits
- Prefer `instructions_edits` over full replacement when possible

Use `propose_config_change` when changing a different agent or changing
non-instruction configuration such as tools, history window, harness, MCP, or
provider setup.

For choices or consent, inspect `propose_config_change` once: use `ask_choice`
for questions and the matching change kind for approvals when its schema
supports them. Both use the same review UI. Skill and task/watcher prompt
proposals use `{id, expected_content, content}`. Wait for `check_proposal`,
then verify the outcome; an answer alone does not apply or approve a change.

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
- Built-in skills are read-only. User skills live in repos managed via
  `GET/POST /api/v1/skills/repos` (and `.../repos/[id]` for PATCH/DELETE), each
  storing `skill-id/SKILL.md`. Writes always target the one repo flagged
  `writable`.

## Shared Bundles And Optional Execution

Author skills and workflows code-first: if a step can be done by code, it must
be done by code, not simulated by the model. Reuse authorized typed tools and
existing implementations before adding scripts. Put specified calculations,
transformations, branching, iteration and checks in code; keep model steps for
intent, ambiguity, judgment and explanation. Give each code step explicit
inputs, outputs and executable validation. Validate machine-checkable properties
of model-generated outputs before downstream use. Missing authorized execution
support is a blocker, not a reason to bypass policy or claim execution occurred.

1. Keep a portable source bundle: `skill-id/SKILL.md` with YAML `name` matching
   the folder, a specific quoted `description`, and explicit Input, Output and
   Validation sections. Supporting scripts, references and assets stay relative
   to that skill root, not the current working directory. Unknown host fields
   must not silently become Jarela permissions.
2. Discover `read_skill` options through `list_tools` with exact `names` and
   `include_schema: true`. Use `inspect_execution: true` or `inspect_bundle: true`
   only when the installed schema supports them. Inspection is not execution,
   immutable snapshot creation, or proof of cross-host compatibility.
3. If the catalog exposes `read_skill_resource`, use it to read bounded UTF-8
   resources from the same selected bundle. It reads script source without
   running it. Do not merge a missing resource from a lower-precedence repo or
   use shell execution to bypass an unavailable/denied resource tool.
4. `write_skill` requires the full Markdown `content`, never a patch or omitted
   body. It does not write support files or import/export complete bundles.
   Read the result back; instructions to run a script do not install a runner.
5. If Privacy & security exposes Skill execution settings, only the local
   unlocked user manages them. Never write policy or approval records through
   memory, environment overrides, direct database edits or a configuration
   proposal. Safe mode and execute capability remain authoritative.
6. Where supported, persistent approval applies to the verified bundle checksum,
   exact agent/workspace and grant limits, not a version label or skill name.
   Different valid inputs may reuse approved code in that scope. Changed code,
   scope or limits needs fresh approval; removed trust is revoked. Do not invent
   a checksum or approval receipt. Settings saved is not evidence a runner exists.
7. Check the actual execution tool and approval state before offering execution.
   The experimental inspector reports `execution_available: false`; stop rather
   than falling back to terminal execution. Choice/approval UI support does not
   imply a checked runner or general durable workflow engine is installed.

## Change Discipline

- Explain what will change and why before proposing or applying persistent
  configuration changes.
- Do not store secrets in instructions, skills, harnesses, memory, or proposal
  payloads.
- After a config change, validate through the narrowest relevant API, UI state,
  or tool call.

## Progress Tracking

- For multi-step configuration work with dependencies, approval, or verification, use `workflow_progress` with a concise inspect → configure → verify checklist. Skip single-setting changes and read-only questions.
- Keep a stable task-specific `workflow_id` and send the complete current item list on each update. Keep credentials and private values out of checklist fields.
- Give each checklist item explicit `input`, `output` and `validation`.
  Mark approval-dependent items `needs_attention` with `needs_user: true` so
  waiting is not automatically retried. Mark items `done` only with observed
  `validation_evidence`; a populated evidence string alone is not proof a check ran.
