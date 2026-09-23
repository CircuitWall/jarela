# 0087 - Default claude_delegate/codex_delegate to full parity with an interactive CLI session

- Status: accepted
- Date: 2026-09-23

## Context

ADR-0071 and ADR-0086 gated `claude_delegate` and `codex_delegate` so that
the default `mostly_safe` safety tier forced a read-only posture
(`--permission-mode dontAsk` / `--sandbox read-only`), requiring a per-call
`allow_unsafe: true` escalation before either tool could write files or run
commands. In practice, nearly every real delegation task needs to edit code,
so callers escalated on almost every call — the default bought little
protection while adding a parameter both tools' descriptions had to explain.

Neither tool offers real per-action approval today: `codex exec` only
accepts a pre-set sandbox policy, and Claude Code headless mode only offers
a whole-session permission mode. Forcing read-only by default did not make
either tool behave like a supervised session; it just meant the common case
required an extra flag.

## Decision

Under `mostly_safe` (default) and `bypass`, both tools now grant full
write/exec access unconditionally: `codex_delegate` always passes
`--sandbox workspace-write`, and `claude_delegate` always honours the
requested `permission_mode` (default `bypassPermissions`). This matches how
a user running either CLI interactively would use it. The `safe` tier is
unchanged — it still refuses both tools outright, since spawning either CLI
inherently grants full read/write/exec.

The now-redundant `allow_unsafe` parameter is removed from both tools'
schemas, from `claude_delegate`'s `resolveSafetyGate`, and from the
`claude-code` integration's `default_allow_unsafe` setting — there is no
longer a lever it would control.

## Consequences

- Good, because the common case (Claude/Codex actually editing files) no
  longer needs an extra escalation flag, and the tool surface is smaller.
- Good, because behavior now matches the tools' own descriptions: "runs like
  a user invoking the CLI directly."
- Bad, because there is now no way to request a read-only delegate run
  short of switching the whole process to `JARELA_TOOL_SAFETY=safe` (which
  blocks the tool entirely rather than sandboxing it). A caller that wants
  Claude/Codex to only investigate must say so in the task prompt.
- Bad, because this removes the one per-call safety lever that existed
  before real per-operation approval (Codex App Server, per ADR-0086) is
  available — operators relying on the old default should pin
  `JARELA_TOOL_SAFETY=safe` if they need delegation blocked outright.

## More Information

Supersedes the `allow_unsafe` escalation shape described in ADR-0071 and
referenced in ADR-0086.
