# Feature contracts for multi-module work

Use a feature contract when a change spans three or more modules, adds a public
interface, or changes persistence, a provider, or a new process. The contract
freezes ownership and interfaces before implementation so parallel or
sequential module work cannot drift apart.

Follow the shared rules in [AGENTS.md](../AGENTS.md). Module review, evidence,
and authority rules are in [MODULE_REVIEW.md](./MODULE_REVIEW.md).

## Pipeline

```text
scope → contract → critique → freeze → interface-first landing
      → per-module implementation → per-module review → integration review → gates
```

1. **Scope.** Map the intended change to modules with the module map in
   [ARCHITECTURE.md](./ARCHITECTURE.md). Check
   [architecture-patterns.json](./architecture-patterns.json) for an existing
   operation before designing a new one.
2. **Contract.** The lead writes one contract with modules, ownership, provided
   and consumed interfaces, validation commands, and the ADR decision.
3. **Critique.** Optionally send each module slice to a read-only critic with
   its guide. It checks feasibility, reuse, boundary compliance, and testability.
4. **Freeze.** The lead resolves conflicts and freezes the contract. Interface
   files land before implementations. Any later interface change is a
   contract-change request, not a silent edit.
5. **Implement.** Emit one packet per module. Each implementer may edit only its
   owned files and must report evidence.
6. **Review.** Run the module review protocol on the combined diff, plus one
   integration review for the seams.
7. **Gates.** Run the deterministic gates on the final tree.

## Contract format

The contract is JSON. The example
[feature-contract.example.json](./feature-contract.example.json) is the pilot
contract for this workflow; use it as a template.

```json
{
  "schemaVersion": 1,
  "feature": "document-retention",
  "title": "Document retention and purge",
  "adrRequired": false,
  "adr": null,
  "shared": ["docs/api.md", "package.json"],
  "modules": [
    {
      "id": "stores",
      "guide": "lib/stores/Agent.md",
      "owns": ["lib/stores/retention.ts", "lib/stores/retention.test.ts"],
      "provides": [
        {
          "name": "setRetentionPolicy",
          "file": "lib/stores/retention.ts",
          "symbol": "setRetentionPolicy"
        }
      ],
      "consumes": [],
      "validation": ["npx vitest run lib/stores/retention.test.ts"]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `feature` | Stable feature slug. |
| `title` | Short human title. |
| `adrRequired` | True when persistence, the data-directory layout, a provider, a new process, or an online-only feature changes. |
| `adr` | Path to `docs/adr/*.md` when `adrRequired` is true. |
| `shared` | Lead-owned files or directory prefixes. Module agents do not edit them. |
| `modules[]` | One entry per owned module. |
| `modules[].id` | Lowercase slug unique within the contract. |
| `modules[].guide` | A guide declared in [scripts/check-agent-docs.mjs](../scripts/check-agent-docs.mjs). |
| `modules[].owns` | Files or directory prefixes ending in `/`. Each changed file needs exactly one owner. |
| `modules[].provides` | Interfaces this module exposes: name, file, and optional symbol. |
| `modules[].consumes` | Interfaces this module needs: module id and provided name. |
| `modules[].validation` | At least one named test or gate command. |

Interfaces should be expressed in code where possible: TypeScript types, Zod
schemas, route contracts, store function signatures, and tool schemas. The
contract references those symbols; it does not restate the type system.

## Validate and emit packets

```sh
# Design-time: ownership, ids, guides, consumes → provides, ADR presence.
npm run feature:contract -- --contract docs/feature-contract.example.json

# Conformance: also require provider files/symbols and owned changed files.
npm run feature:contract -- --contract <file> --implemented

# A committed or staged range instead of the working tree.
npm run feature:contract -- --contract <file> --staged --implemented
npm run feature:contract -- --contract <file> --base origin/main --head HEAD --implemented

# One self-contained implementation packet per module.
npm run feature:contract -- --contract <file> --packets <dir-outside-the-repo>
```

Use `--ignore <path>` for unrelated untracked work. Write briefs and packets
outside the repository, or to a directory the contract does not check, so they
do not become unowned changes.

The gate checks:

- Contract shape and unique module ids.
- Guides exist and are declared module guides.
- Ownership is disjoint across modules and does not overlap `shared`.
- Every `consumes` edge matches a `provides` entry in the named module.
- With `--implemented`, every changed file is owned by one module or `shared`.
- With `--implemented`, provider files exist and optional symbols appear in
  them. The symbol check is a structural presence check, not proof of behavior.
- A declared ADR resolves; changed persistence, data-directory, or provider
  registration files produce an advisory trigger when no ADR is declared.

## Packets

A packet is portable Markdown for any coding agent. It contains the feature and
guide, owned files, provides and consumes, validation commands, lead-owned
shared files, a contract slice, and an output contract. The implementer must:

- Read `AGENTS.md` and the guide first.
- Edit only owned files.
- Stop and report a contract-change request when the contract is wrong; do not
  invent a different interface.
- Report commands run with output and distinguish observed facts from
  assumptions.

The packet format matches the `delegate_to_agent` handoff shape used by the
runtime: task, context, expected output, and validation criteria.

## Ownership and sequencing

- **One interface owner.** The lead owns `shared` and cross-module interfaces.
- **One owner per file.** Overlapping ownership is a contract error.
- **Topological waves.** Follow the module map's dependency direction:
  persistence → stores → runtime modules → API routes → shared client →
  hooks/components. Consumers start after their provider's interface exists.
- **Interface-first.** Land shared types, schemas, and route contracts before
  module implementations.
- **Contract changes are explicit.** A module agent requests a change with
  evidence; the lead updates the contract and re-issues affected packets.

## Review and limits

Run [MODULE_REVIEW.md](./MODULE_REVIEW.md) on the combined diff, then one
integration review for the seams: every consume has a provider, signatures and
error semantics agree, migrations and transactions line up, and docs, API
docs, architecture patterns, and owning guides are updated.

- The contract is feature-scoped. It expires when the feature lands; it is not
  a second long-lived architecture document.
- The deterministic gate is not a proof of behavior. Tests and the module gates
  remain authoritative.
- A contract cannot fix ambiguous requirements; a bad contract only makes wrong
  assumptions concrete.
- Small changes do not need a contract. Use the tiers in
  [MODULE_REVIEW.md](./MODULE_REVIEW.md#tiers).
