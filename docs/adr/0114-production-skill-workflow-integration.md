# ADR-0114: Explicit skill execution and durable workflow integration

Status: **Implementation; release acceptance remains pending**

Date: 2026-10-30

Related: [ADR-0112](0112-checked-javascript-skill-execution.md),
[ADR-0113](0113-gated-workflow-runtime.md), #827, #828.

## Decision

Complete the application integration requested after the internal runtime landed.
This supersedes the internal-only coding gate, not human execution consent or
release acceptance. Discovery stays inert. An explicitly enabled execute tool
or unlocked local API creates a bounded execution operation. The existing
pending-action review surface approves exact captured code, invocation bytes,
workspace, runtime and limits. It does not interpret skill instructions as
authority. Default policy remains ask each time; safe mode and capability
revocation independently prevent launch.

Executable artifacts and one-use consent remain in memory. Persisted proposals
reference live requests, not runnable snapshots. A restart invalidates them.
Code may be inspected before approval; changing the selected source invalidates
the request. Exact trusted-revision receipts may waive repeat invocation consent
only within their existing policy scope. A workflow choice never grants script
permission. Full-trust scripts are not sandboxed and may access the host and
network as the application user.

The platform owner must establish process ownership before script execution and
report cleanup positively. Unsupported ownership environments fail explicitly.
No shell-text execution or PATH lookup selects the Node runtime. Platform
limitations must be visible; tests cannot turn a process-group guarantee into
a sandbox claim.

Durable workflow definitions, inputs, checked outputs and ownership belong to
a dedicated versioned store, encrypted with the existing envelope mechanism.
Local unlocked routes and agent-scoped tools enforce ownership. Recover only
after independently establishing that the previous process owner is dead.
Interrupted writes require observed reconciliation; never retry them blindly.
Neither restarts nor retention cleanup recover executable consent.

### Execution settlement amendment

Cancellation/timeout may return while a non-cooperative tool is still running.
Retain the actual host invocation process-wide until settlement; forbid
read-back reconciliation during that interval and drain it during shutdown.
Late results only release ownership, never rewrite persisted uncertainty.
Workflow tool calls bypass early wallclock/background receipts and SDK abort
rejections; the coordinator owns the response deadline. This is not a guarantee
that a remote effect is rolled back or final merely because a promise settled.

Run-owned staging records application ownership outside captured script bytes.
Cleanup may remove only recognized owned directories after proving the owner
dead and checking directory identities and links. Unknown or possibly live
directories are retained and reported, not recursively swept. Workflows have
bounded retained records and explicit terminal-run retention.

## Validation

Require actual descendant processes, early-parent-exit, cancellation, timeout,
approval duplication/expiry, changed source, policy revocation and restart tests.
Exercise the app API/UI and tool path with synthetic data in a temporary data
directory. Preserve the supported-host matrix and human release walkthrough as
separate acceptance evidence. Passing unit tests alone does not close #826–#828.
