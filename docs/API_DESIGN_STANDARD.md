# API design standard

This is the v1 development contract. The helper migration and lint guard are
**Unreleased**; existing payloads and status codes are unchanged. This focused
update does not advance the full documentation review baseline in [index.md](index.md).
See [api.md](api.md) for individual endpoints and
[architecture-patterns.json](architecture-patterns.json) for canonical operations.

## Compatibility first

- Successful JSON responses retain their endpoint-specific shape: a resource,
  an array, or an object containing named fields. Do not add a universal `data`,
  `meta`, or timestamp envelope.
- Ordinary HTTP errors are `{ "error": "message" }`. Use
  `errorResponse(message, status)` from
  [lib/api/responses.ts](../lib/api/responses.ts). Its default status is 400.
- Errors with existing `code`, `detail`, `ok`, `action`, `path`, validation issues,
  or retry metadata use `errorJson(body, init)`. Pass the original body, status,
  and headers unchanged. Do not drop fields or introduce a new code vocabulary.
- Use `notFoundResponse()` for the default `404 { "error": "Not found" }`.
  [NOT_FOUND_ERRORS](../lib/api/errors.ts) centralizes existing fixed messages;
  legacy capitalization is intentional. Parameterized messages stay local.
- A new envelope, changed message/status relied on by a caller, or removed field
  requires an explicit compatibility/deprecation decision, not a bulk cleanup.

```typescript
import { NextResponse } from "next/server";
import { errorJson, errorResponse, notFoundResponse, validateBody } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";
import { z } from "zod";

const PatchBody = z.object({ label: z.string().nullable().optional() });

// Inside a handler:
const parsed = await validateBody(req, PatchBody);
if (parsed instanceof NextResponse) return parsed;
if (!resource) return notFoundResponse(NOT_FOUND_ERRORS.AGENT);
if (conflict) return errorResponse("Resource already exists", 409);

return errorJson(
  { error: "rate-limited", retry_after_ms: 2500 },
  { status: 429, headers: { "Retry-After": "3" } },
);
```

`errorJson` is a shape-preserving builder, not an error classifier or sanitizer.
Callers still own safe error messages, status selection, authorization, logging,
and headers. ESLint's `jarela-api/shared-errors` rule rejects inline error-bearing
`NextResponse.json` / `Response.json` calls with explicit HTTP error statuses,
including dynamic statuses, and error-only responses missing an explicit status.
It does not infer failures from arbitrary payload variables.

## Validation and types

- Validate JSON at the API boundary with Zod. Reuse an owning domain schema
  rather than maintaining a second competing contract under a new directory.
- For ordinary JSON bodies, `validateBody(req, schema)` returns parsed data or a
  400 response. Malformed JSON returns `"Request body must be valid JSON"`;
  schema failure returns its first issue. Existing bounded-body readers and
  routes with deliberately different validation messages keep those contracts.
- Validate query strings, path-dependent constraints, multipart uploads, and
  binary payloads explicitly with their transport-specific parsers.
- Client contracts live in [api/types.ts](../api/types.ts); domain schemas may
  own inferred types. Keep input/output types aligned when changing fields.
- Unreleased document-source contracts are owned by
  [api/document-sources.ts](../api/document-sources.ts). Collection and item
  routes reuse its mutation schemas; client and store statistics types are
  inferred from the same definitions and re-exported through existing paths.
  Mail-specific configuration validation remains in the owning mail module.
  Collection statistics use one aggregate SQLite query, including empty and
  disabled sources, rather than one query set per source.
- Shared collection/item shapes use [serializers.ts](../lib/api/serializers.ts).
  Pass already-read data (such as document source stats) to pure serializers.
  Do not hide database reads, catch corrupt persisted JSON, or expose private
  cursor/credential fields in a serializer.

## Statuses, headers, and transports

| Status | Default meaning for new endpoints |
| --- | --- |
| 200 | Successful read/update/delete or a completed domain probe |
| 201 | Resource created (`createdResponse` preserves the supplied body) |
| 202 | Work accepted, not evidence that execution completed |
| 204 | No body; use an empty `Response`, not JSON |
| 400 | Malformed or invalid input |
| 401 / 403 | Authentication / authorization refusal |
| 404 | Resource missing |
| 409 | Conflict or state transition refused |
| 413 | Body too large |
| 422 | Only when an endpoint explicitly defines structured validation |
| 423 | Locked state |
| 429 | Rate limited; retain `Retry-After` and retry metadata |
| 500 / 502 / 503 | Internal / upstream / unavailable failure |

Preserve existing statuses during maintenance. In particular:

- Integration/provider probes may return `200 { ok: false, error, ... }`;
  OAuth status responses may contain a nullable `error`. These are domain
  results, not HTTP failures. Do not turn them into 4xx responses.
- Use `noStoreJson` or retain `Cache-Control: no-store` for sensitive/live data.
  Keep the original cache, retry, CORS, and authentication headers on errors too.
- SSE, binary downloads, plain-text errors, OAuth callback HTML/redirects,
  multipart parsing, and empty responses keep their own transport contracts.
  Do not JSON-wrap them or change SSE recovery/terminal semantics.
- Await dynamic route `params` (Next.js 16); consult the local Next docs before
  changing framework APIs.

## Validation checklist

1. Assert the complete success body and status, without an invented envelope.
2. Cover malformed input, schema rejection, missing resources, conflicts, and
   relevant failure paths. Assert existing error fields/messages and headers.
3. Check both list and item callers when changing a shared serializer.
4. Run focused route/client tests, `npx tsc --noEmit`, and `npm run lint`;
   use the production build for cross-cutting changes.
5. Inspect the diff for authorization, secret redaction, ordering, caching,
   and lifecycle changes. Mechanical helper migration must not change them.
