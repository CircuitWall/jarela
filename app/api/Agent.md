---
description: "Use when: implementing, fixing, or testing API routes in app/api/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# API routes module guidance

Follow [AGENTS.md](../../AGENTS.md), the change SOP, and the
[API design standard](../../docs/API_DESIGN_STANDARD.md).
The implementation and endpoint tests are authoritative; do not invent helpers,
schemas, or response envelopes from generic REST examples.

## Route shape and ownership

- One resource per route module under [app/api/v1/](./v1/):
  `app/api/v1/<resource>/route.ts` for collection/create and
  `app/api/v1/<resource>/[id]/route.ts` for item operations. Export only HTTP
  method handlers (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, plus `HEAD`/
  `OPTIONS` where the transport requires them) and route metadata; shared
  payload helpers live in a non-route module beside them.
- Await dynamic route parameters (Next.js 16): `const { id } = await params;`.
  Read the installed Next.js docs before changing framework APIs.
- Routes orchestrate: validate → enforce the existing authorization/capability
  gate → call a typed store or runtime function → serialize. No SQL, no
  `.prepare`, no UI imports, and no `getDb()` except documented bootstrap work.
- Long-running work returns the operation resource (often 202) instead of
  holding the request open when an operation record already represents
  progress. Preserve operation ordering, approvals, and cancellation.
- Loopback-only and extension surfaces use the shared guard (for example
  [local-execution-guard.ts](../../lib/api/local-execution-guard.ts)) or the
  owning extension guard; never hand-roll host, origin, or proxy-header checks.
- Mark the surface in the file header per the
  [API design standard](../../docs/API_DESIGN_STANDARD.md): `@public` for app
  integrations, `@public-internal` for the paired browser extension. Everything
  else is UI-internal and stays unmarked.

## File map

| Concern | Files |
| --- | --- |
| Route modules | `app/api/v1/<resource>/route.ts`, `app/api/v1/<resource>/[id]/route.ts` |
| Response builders | [responses.ts](../../lib/api/responses.ts), [errors.ts](../../lib/api/errors.ts) |
| Serializers | [serializers.ts](../../lib/api/serializers.ts) |
| SSE | [sse.ts](../../lib/api/sse.ts) |
| Client contract | [client.ts](../../api/client.ts), [types.ts](../../api/types.ts) |
| Public docs | [docs/api.md](../../docs/api.md) |

## Status, headers, and transport contract

- Use the shared builders: `createdResponse` for 201, an empty `Response` for
  204, and `errorResponse` / `errorJson` / `notFoundResponse` for failures.
  Do not build error-bearing `NextResponse` JSON calls inline (ESLint's
  shared-errors rule enforces this).
- Cache deliberately: `cachedJson` for private, frequently re-read list/value
  data; `noStoreJson` for credentials, live connection state, and config that
  must never be stale. Preserve cache, retry, CORS, and authentication headers
  on error responses too.
- Keep domain results as 200 responses: integration/provider probes may return
  `{ ok: false, error }`, and OAuth status may carry a nullable `error`. Do not
  convert them to HTTP failures.
- SSE goes through [sse.ts](../../lib/api/sse.ts) and keeps its headers,
  heartbeat, replay, and terminal semantics. Do not JSON-wrap SSE, binary
  downloads, text errors, OAuth callback HTML, or redirects.
- Use 202 for accepted work, 204 for no body, 409 for conflicts and refused
  transitions, 413 for oversized bodies, 423 for locked state, and 429 with
  `Retry-After` for rate limits. 422 requires an endpoint-specific structured
  contract.

## Security, limits, and redaction

- Enforce the route's existing authorization or capability gate before doing
  work, and never add an unauthenticated alias for a privileged operation.
- Validate and bound request bodies; reject unknown fields where the owning
  schema is strict. Use transport-specific parsers for multipart and binary
  inputs.
- Mask credential parameters and proxy passwords in responses. MCP
  `spec.env`/`spec.headers` may round-trip to the authenticated operator editor
  but must never reach logs, agent output, notifications, or unauthenticated
  responses.

## Client and documentation parity

- When a field, status, or header changes, update [api/types.ts](../../api/types.ts),
  [api/client.ts](../../api/client.ts), and both collection and item callers.
- A route joins the public surface only with a `@public` marker and an entry in
  [docs/api.md](../../docs/api.md); `npm run api-docs:check` enforces agreement.
- Run `npm run security:routes` when adding server-only or heavy imports to a
  route bundle.
- New serializers stay pure: pass already-read data, do not hide database IO,
  and do not expose private cursor or credential fields.

## Preserve the v1 contract

- Successful JSON returns the endpoint's resource, array, or named-field object.
  Do not introduce a universal `{ data }` wrapper.
- `errorResponse(message, status = 400)` returns `{ error: message }`.
- `errorJson(body, init)` retains structured fields and response headers.
- `notFoundResponse(message)` returns 404; use existing fixed wording from
  [NOT_FOUND_ERRORS](../../lib/api/errors.ts), including legacy capitalization.
- Reuse [shared serializers](../../lib/api/serializers.ts) for collection/item
  shapes. Pass required data explicitly; serializers must not hide database IO.
- Keep HTTP-200 probe failures and OAuth status payloads as domain results.
  Preserve SSE, binary, HTML, redirects, and plain-text transport behavior.
- Keep cache, CORS, retry, and authentication headers. Error builders do not
  sanitize messages or supply authorization.

## Validate inputs and types

- Use the owning Zod schema at JSON boundaries. Reuse
  `validateBody(req, schema)` for ordinary JSON bodies; it returns parsed data or
  a 400 `NextResponse`, including on malformed JSON.
- Direct `schema.safeParse()` stays appropriate for query/path parameters,
  optional bodies with endpoint-specific defaults, and nested/derived contracts
  (pending-action choices, OAuth payloads) where `validateBody` would change the
  documented error shape. Do not migrate those mechanically.
- Keep bounded-body readers and endpoint-specific validation messages intact.
  Validate queries, multipart uploads, and binary inputs explicitly.
- Do not mechanically replace 400 with 422. Structured 422 responses require an
  explicit endpoint contract.
- Check [client types](../../api/types.ts) and relevant
  [client methods](../../api/client.ts) before changing fields.
- Await dynamic `params`; read the installed Next.js docs before changing
  framework APIs.

```typescript
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateBody } from "@/lib/api/responses";

const Body = z.object({ label: z.string().nullable().optional() });

export async function PATCH(req: NextRequest) {
  const parsed = await validateBody(req, Body);
  if (parsed instanceof NextResponse) return parsed;
  // Dispatch to the owning operation and serialize its documented result.
}
```

## Error handling and lifecycle

- Distinguish invalid input, missing resources, conflicts, and unexpected errors
  using the existing endpoint's status and error codes.
- Preserve operation ordering, approvals, credential isolation, capability gates,
  notifications, cancellation, and persistence semantics.
- Never return a success-shaped fallback for failed work.
- Do not expose stack traces, secrets, or raw provider payloads. Use safe messages
  and repository-standard logging; helpers are not a substitute for this review.
- Return empty responses without JSON for 204. Do not convert existing DELETE
  responses to 204 during cleanup.

## Anti-patterns

- **Universal response envelope** — wrapping every success in `{ data }` breaks
  the v1 contract. Return the resource, array, or named-field object.
- **Inline error bodies** — hand-built error JSON loses the shared status,
  headers, and structured fields that `errorJson` preserves.
- **Routes that reach around stores** — SQL, `.prepare`, or direct table access
  bypasses transactions, encryption, and row mapping.
- **Unvalidated transport input** — trusting JSON, query, path, or multipart
  values turns malformed input into a 500 instead of the documented 400.
- **Success-shaped failures** — returning 200 for failed work, or converting
  domain probe results into HTTP errors, breaks callers and observability.

## Review checks

- [ ] The route only orchestrates: validate, gate, call a typed store/runtime function, serialize.
- [ ] No SQL, `.prepare`, UI imports, or undocumented `getDb()` bootstrap.
- [ ] Shared response builders, statuses, cache headers, and transport rules are preserved.
- [ ] Zod validation covers malformed JSON, query/path parameters, and body bounds.
- [ ] Authorization/capability and redaction behavior are unchanged.
- [ ] Public markers and client types/methods are updated with the contract.
- [ ] Tests cover success, failure, headers, and shared-serializer callers.
- [ ] Focused route/client tests, `npx tsc --noEmit`, and `npm run lint` pass.

## Validation before completion

1. Cover complete success/error bodies, statuses, and meaningful headers.
2. Test malformed JSON, invalid fields, missing resources, conflicts, and relevant
   operation failures without weakening existing assertions.
3. Check both collection and item callers for shared serializer changes.
4. Confirm the route has no SQL, no UI import, and no bypassed gate.
5. Update the client types/methods and the `@public` documentation in the same
   change when the contract moved.
6. Run focused route/client tests, `npx tsc --noEmit`, and `npm run lint`.
7. Run the production build for cross-cutting changes and inspect the final diff.

ESLint enforces shared inline HTTP error construction.
`npm run lint:complexity` checks the 150-line production function-body ratchet;
existing exceptions require review rather than arbitrary splitting.
See [Contributing](../../CONTRIBUTING.md#api-design-and-technical-debt).
