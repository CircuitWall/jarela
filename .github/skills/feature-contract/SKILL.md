---
name: feature-contract
description: "Use when: designing or implementing a large Jarela feature that spans three or more modules, adds a public interface, or changes persistence, a provider, or a process. Freezes ownership and interfaces, emits per-module implementation packets, and validates conformance."
argument-hint: "Feature description, issue, or existing contract path"
---

# Feature contract

## Goal

Freeze the module boundaries, file ownership, and interfaces of a
high-blast-radius feature before implementation so module work cannot drift
apart. The contract is feature-scoped and expires when the feature lands.

Protocol: [docs/FEATURE_CONTRACT.md](../../../docs/FEATURE_CONTRACT.md).

## SOP

1. **Scope.** Map the intended change to modules with the module map in
   [docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md). Check
   [docs/architecture-patterns.json](../../../docs/architecture-patterns.json)
   for an existing operation before designing a new one.

2. **Contract.** Write one JSON contract using
   [docs/feature-contract.example.json](../../../docs/feature-contract.example.json)
   as the template. Every changed file needs exactly one owner. Express
   interfaces as code where possible.

3. **Critique.** Optionally send each module slice to a read-only critic with
   its guide. Check feasibility, existing-code reuse, boundary compliance, and
   testability. The lead resolves conflicts and freezes the contract.

4. **Validate the design:**

   ```sh
   npm run feature:contract -- --contract <file>
   ```

5. **Emit packets:**

   ```sh
   npm run feature:contract -- --contract <file> --packets <dir-outside-the-repo>
   ```

   Give one packet to each module implementer. They may edit only owned files
   and must stop on a contract mismatch.

6. **Validate conformance:**

   ```sh
   npm run feature:contract -- --contract <file> --implemented --base origin/main --head HEAD
   ```

7. **Review.** Run the module review protocol on the combined diff, plus one
   integration review for the seams.

## Rules

- One interface owner: the lead owns `shared` and cross-module interfaces.
- One owner per file; overlapping ownership is a contract error.
- Land shared types, schemas, and route contracts before implementations.
- A module agent requests a contract change with evidence; it does not invent a
  different interface.
- The deterministic gate is necessary but not sufficient. Tests and module
  gates remain authoritative.
