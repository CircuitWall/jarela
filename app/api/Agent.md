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

## Validation before completion

1. Cover complete success/error bodies, statuses, and meaningful headers.
2. Test malformed JSON, invalid fields, missing resources, conflicts, and relevant
   operation failures without weakening existing assertions.
3. Check both collection and item callers for shared serializer changes.
4. Run focused route/client tests, `npx tsc --noEmit`, and `npm run lint`.
5. Run the production build for cross-cutting changes and inspect the final diff.

ESLint enforces shared inline HTTP error construction.
`npm run lint:complexity` checks the 150-line production function-body ratchet;
existing exceptions require review rather than arbitrary splitting.
See [Contributing](../../CONTRIBUTING.md#api-design-and-technical-debt).
