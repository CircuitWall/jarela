# Module review orchestration

Use this when reviewing a change that touches one or more modules. It defines
the harness-neutral protocol behind `npm run review:module -- --briefs`. The
deterministic gate remains the merge authority; reviewers add judgment that
scripts cannot verify.

Follow the shared rules in [AGENTS.md](../AGENTS.md) and the guide contract in
[AGENT_MD_SYSTEM.md](../AGENT_MD_SYSTEM.md).

## Tiers

| Tier | Trigger | Workflow |
| --- | --- | --- |
| 0 | One module, no interface change | `npm run review:module -- --staged`; resolve findings in the same session |
| 1 | Two modules or one internal interface | Tier 0 plus one portable brief per module and one integration check |
| 2 | Three or more modules, a public interface, persistence, a provider, or a new process | [Feature contract](./FEATURE_CONTRACT.md) and per-module review |

Most changes are Tier 0. Do not pay the coordination cost of fan-out for a
single-module change.

## Inputs, outputs, validation

| Step | Input | Output | Validation |
| --- | --- | --- | --- |
| Map | Git range or staged change | `modules[]` with guides, changed files, review checks, and mechanical findings | `npm run review:module -- --json` |
| Brief | Gate JSON | One Markdown brief per module | `--briefs <dir>`; each brief names its guide and checks |
| Review | Brief, guide, diff | Findings with evidence | Read-only reviewer; every confirmed finding cites a file and line or command output |
| Consolidate | Reviewer reports and gate result | One report split into mechanical and judgment findings | Lead reruns the gate; no reviewer claim overrides it |

## Protocol

1. Establish the range. Use `--staged`, `--base <ref> --head <ref>`, or the
   default working tree. Record the resolved range in the report.
2. Generate the work orders:

   ```sh
   npm run review:module -- --staged --json --briefs <dir-outside-the-repo>
   ```

   The gate maps each changed file to its owning guide, extracts the guide's
   `## Review checks`, and runs the mechanical module invariants.
3. Dispatch one reviewer per brief. Give it the brief path and the guide path.
   Do not duplicate the guide's text into the prompt; the guide is the source
   of truth and the brief points at it.
4. Keep reviewers read-only. Their job is to verify claims against code and
   tests, not to fix them.
5. Consolidate before acting. Separate mechanical failures from reviewer
   findings, deduplicate by rule and location, and rerun the gate after any
   edit.
6. Validate the final tree with the repository gates: `npm run review:module`,
   `npm run check:impact`, and `npm run lint`.

## What the brief contains

- The owning guide and module scope.
- The resolved change range and the exact diff command.
- Changed files.
- The guide's Review checks.
- Mechanical findings already detected, so reviewers verify rather than
  re-derive them.
- A bounded procedure: read the guide, inspect only the changed files and the
  code they directly touch, cite evidence, classify drift.
- The finding output contract and the read-only rule.

The brief does not embed the whole guide, the whole diff, or the repository.
It is a work order, not a context dump.

## Finding contract

```json
{
  "module": "lib/tools/Agent.md",
  "verdict": "clean",
  "findings": [
    {
      "severity": "error",
      "classification": "behavioral-drift",
      "status": "confirmed",
      "claim": "The tool is registered but its description omits when not to use it.",
      "evidence": "lib/tools/general/example.ts:42",
      "authority": "code"
    }
  ],
  "commandsRun": ["npx vitest run lib/tools/general/example.test.ts"],
  "claimsChecked": ["The tool module is imported from runtime/builtins.ts"]
}
```

- `severity`: `error`, `warn`, or `nit`.
- `classification`: `behavioral-drift`, `stale-guide`,
  `undocumented-pattern`, or `structural-gap`.
- `status`: `confirmed` or `suspected`.
- `evidence`: a file and line, a test result, or command output.
- `authority`: which side should change when code and guide disagree.

A report with no findings must list the claims checked and commands run. A
green gate plus a clean review covers only the files read; it is not a
repository-wide certification.

## Evidence and authority

- Mechanical findings are facts about the tree. Fix them or explain why the
  rule does not apply.
- Reviewer findings are model judgment. Treat unconfirmed claims as
  hypotheses, not defects.
- Code is authoritative for what happens; the guide is authoritative for what
  should happen. State which side is wrong instead of quietly changing the
  other.
- Never silently edit a guide to match a bug, or code to match an aspirational
  claim.

## Dispatch is harness-specific

The brief is portable; the dispatch mechanism is not.

- **Claude Code:** spawn one subagent per brief with the Agent tool, or run a
  workflow that fans out and verifies.
- **GitHub Copilot:** use its custom-agent or delegation mechanism where
  available; otherwise run the briefs sequentially in one session.
- **Any other agent:** read the brief and the named guide, follow the procedure,
  return the finding contract.
- **No subagent support:** run the briefs sequentially. The output is the same;
  only wall-clock time changes.

Do not rely on auto-loading. A fresh reviewer is not told to audit unless the
brief says so; naming the guide is part of the brief.

## Cost controls

- Run the deterministic gate first. Do not spend model tokens rediscovering
  registrations, pragmas, boundary imports, or naming rules.
- Bound the brief to changed files and the code they directly touch.
- Use one reviewer per module, not one per file. Cap concurrency and findings.
- Use the strongest model for consolidation and design; mechanical review can
  use a cheaper model.
- Reserve Tier 2 for high-blast-radius work. A Tier 2 run can cost several
  times a single-agent session; measure tokens per confirmed finding before
  widening it.

## Related

- [Feature contracts](./FEATURE_CONTRACT.md) for multi-module features.
- [AGENT_MD_SYSTEM.md](../AGENT_MD_SYSTEM.md) for the guide contract and the
  single-guide audit procedure.
- [scripts/check-module-review.mjs](../scripts/check-module-review.mjs) for the
  deterministic mapping and brief generation.
