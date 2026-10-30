---
description: "Use when: implementing, fixing, or testing API routes in app/api/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# API Routes Module Agent

**Specialization:** Building and maintaining Next.js API routes with consistent contracts, validation, and error handling.

**Scope:** `app/api/` directory. All route handlers (`route.ts` files) and shared API utilities.

---

## 🎯 Domain Context

### What API Routes Are

API routes are the **HTTP interface** between frontend and backend:
- Input: HTTP request (URL, body, headers, query params)
- Output: HTTP response (status code, body, headers)
- Purpose: Execute business logic, persist data, orchestrate agents

### Key Principles

1. **Standard Response Format**
   - All success responses: `{ data: T }`
   - All error responses: `{ code, message, timestamp }`
   - Consistent status codes (see mapping below)

2. **Input Validation**
   - Use Zod schemas to parse and validate request bodies
   - Parse query params with Zod
   - Return 422 UNPROCESSABLE_ENTITY for validation errors

3. **Type Safety**
   - Route handlers are typed (not implicit `any`)
   - Request body type checked at compile time
   - Response shape known in advance (no runtime surprises)

4. **Error Handling**
   - Catch all errors, return appropriate status
   - Distinguish user errors (400, 422) from server errors (500)
   - Log errors for debugging
   - Never expose stack traces to clients

5. **Route Organization**
   - Group related routes in subdirectories
   - Use nested `[id]` folders for dynamic segments
   - Filename is HTTP method: `route.ts` contains GET/POST/PUT/DELETE

---

## 📊 Status Code Mapping

| Status | Semantic | Example |
|--------|----------|---------|
| 200 | OK - successful GET/PUT/DELETE | Document retrieved |
| 201 | Created - successful POST | Agent created |
| 204 | No Content - successful DELETE with no body | Deleted (no return value) |
| 400 | Bad Request - malformed input | Invalid JSON body |
| 401 | Unauthorized - missing credentials | No API key |
| 403 | Forbidden - insufficient permissions | User lacks role |
| 404 | Not Found - resource doesn't exist | Agent not found |
| 409 | Conflict - constraint violation | Duplicate name |
| 422 | Unprocessable Entity - validation failed | Field-level errors |
| 500 | Internal Server Error - unexpected failure | Database connection failed |

---

## 📋 Coding Patterns

### Pattern 1: Basic GET Handler

```typescript
// app/api/v1/agents/route.ts

import { NextRequest, NextResponse } from "next/server";
import { listAgents } from "@/lib/agents/queries";
import { errorResponse, successResponse } from "@/lib/api/responses";

// 1. Type the response explicitly
type AgentsResponse = {
  agents: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
};

// 2. Handler with typed request/response
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // 3. Execute business logic
    const agents = await listAgents();

    // 4. Return typed success response
    return successResponse<AgentsResponse>(
      { agents: agents.map(a => ({ id: a.id, name: a.name, description: a.description })) },
      200
    );
  } catch (error) {
    // 5. Return consistent error response
    console.error("Failed to list agents:", error);
    return errorResponse("internal_error", "Failed to list agents", 500);
  }
}
```

**Checklist:**
- ✅ Response type defined (`AgentsResponse`)
- ✅ Error handling with try/catch
- ✅ Uses shared response helper
- ✅ Error logged for debugging
- ✅ No stack traces exposed to client

---

### Pattern 2: POST Handler with Validation

```typescript
// app/api/v1/agents/route.ts

import { z } from "zod";
import { CreateAgentPayload } from "@/lib/api/contracts/agents";
import { errorResponse, validationError } from "@/lib/api/responses";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. Parse and validate body
    const body = await request.json();
    const payload = CreateAgentPayload.parse(body);

    // 2. Business logic
    const agent = await createAgent(payload);

    // 3. Return created resource with 201
    return successResponse({ data: agent }, 201);
  } catch (error) {
    // 4. Handle validation errors
    if (error instanceof z.ZodError) {
      return validationError(error.flatten().fieldErrors);
    }

    // 5. Handle business logic errors
    if (error instanceof AgentConflictError) {
      return errorResponse(
        "conflict",
        `Agent with name "${error.name}" already exists`,
        409
      );
    }

    // 6. Handle unexpected errors
    console.error("Failed to create agent:", error);
    return errorResponse("internal_error", "Failed to create agent", 500);
  }
}
```

**Checklist:**
- ✅ Body parsed before type checking
- ✅ Validation schema centralized in `lib/api/contracts/*`
- ✅ Zod errors converted to structured validation response
- ✅ Business logic errors mapped to appropriate status codes
- ✅ 201 status for successful creation
- ✅ Errors include helpful context (not just generic message)

---

### Pattern 3: Dynamic Route Handler

```typescript
// app/api/v1/agents/[id]/route.ts

import { NextRequest, NextResponse } from "next/server";
import { getAgent, updateAgent, deleteAgent } from "@/lib/agents/operations";

// 1. Type the route params
type Params = { id: string };

// 2. GET single resource
export async function GET(request: NextRequest, { params }: { params: Params }): Promise<NextResponse> {
  try {
    const agent = await getAgent(params.id);

    if (!agent) {
      return errorResponse("not_found", "Agent not found", 404);
    }

    return successResponse({ data: agent }, 200);
  } catch (error) {
    console.error("Failed to get agent:", error);
    return errorResponse("internal_error", "Failed to get agent", 500);
  }
}

// 3. PUT to update
export async function PUT(request: NextRequest, { params }: { params: Params }): Promise<NextResponse> {
  try {
    const body = await request.json();
    const payload = UpdateAgentPayload.parse(body);
    
    const agent = await updateAgent(params.id, payload);

    if (!agent) {
      return errorResponse("not_found", "Agent not found", 404);
    }

    return successResponse({ data: agent }, 200);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return validationError(error.flatten().fieldErrors);
    }
    console.error("Failed to update agent:", error);
    return errorResponse("internal_error", "Failed to update agent", 500);
  }
}

// 4. DELETE resource
export async function DELETE(request: NextRequest, { params }: { params: Params }): Promise<NextResponse> {
  try {
    const success = await deleteAgent(params.id);

    if (!success) {
      return errorResponse("not_found", "Agent not found", 404);
    }

    // 204 No Content (no response body)
    return NextResponse.json(null, { status: 204 });
  } catch (error) {
    console.error("Failed to delete agent:", error);
    return errorResponse("internal_error", "Failed to delete agent", 500);
  }
}
```

**Checklist:**
- ✅ Route params typed explicitly
- ✅ Each HTTP method is separate function
- ✅ 404 returned when resource doesn't exist
- ✅ 204 used for DELETE with no return value
- ✅ All error cases handled

---

## 🚫 Anti-Patterns (AVOID THESE)

### ❌ Anti-Pattern 1: Unstructured Error Response

```typescript
// ❌ BAD - Inconsistent format
export async function GET(request: NextRequest) {
  if (!something) {
    return NextResponse.json({ error: "Invalid" }, { status: 400 });  // String error
  }
  return NextResponse.json({ message: "Success" }, { status: 200 });  // Different format!
}

// ✅ GOOD - Consistent format
export async function GET(request: NextRequest) {
  if (!something) {
    return errorResponse("validation_error", "Invalid input", 422);
  }
  return successResponse({ data: result }, 200);
}
```

### ❌ Anti-Pattern 2: No Validation

```typescript
// ❌ BAD - Accepts any input
export async function POST(request: NextRequest) {
  const body = await request.json();  // Could be anything!
  const agent = await createAgent(body.name, body.config);
  return NextResponse.json(agent);
}

// ✅ GOOD - Validates input shape
export async function POST(request: NextRequest) {
  const body = await request.json();
  const payload = CreateAgentPayload.parse(body);  // Throws if invalid
  const agent = await createAgent(payload.name, payload.config);
  return successResponse({ data: agent }, 201);
}
```

### ❌ Anti-Pattern 3: Implicit Error Codes

```typescript
// ❌ BAD - Unclear why this returned 400
if (error.message.includes("not found")) {
  return NextResponse.json({ error: error.message }, { status: 400 });
}

// ✅ GOOD - Explicit error code
if (error instanceof NotFoundError) {
  return errorResponse("not_found", error.message, 404);
}
```

### ❌ Anti-Pattern 4: Exposing Stack Traces

```typescript
// ❌ BAD - Leaks internal implementation
catch (error) {
  return NextResponse.json(
    { error: error.toString(), stack: error.stack },  // 🚨 Security issue!
    { status: 500 }
  );
}

// ✅ GOOD - Sanitize errors
catch (error) {
  console.error("Error details:", error);  // Log for debugging
  return errorResponse(
    "internal_error",
    "An unexpected error occurred",  // Generic for client
    500
  );
}
```

### ❌ Anti-Pattern 5: No Status Code for Errors

```typescript
// ❌ BAD - Always returns 200
try {
  // ...
} catch (error) {
  return NextResponse.json({ error: error.message });  // Status = 200! 🚨
}

// ✅ GOOD - Correct status code
try {
  // ...
} catch (error) {
  return errorResponse("internal_error", error.message, 500);
}
```

---

## 📁 File Structure

```
app/api/
├── v1/                               ← API version
│   ├── agents/
│   │   ├── route.ts                  ← GET (list), POST (create)
│   │   └── [id]/
│   │       └── route.ts              ← GET (read), PUT (update), DELETE
│   ├── documents/
│   │   ├── route.ts                  ← CRUD for documents
│   │   ├── search/route.ts           ← Special: search endpoint
│   │   └── sources/
│   │       ├── route.ts              ← Document sources CRUD
│   │       └── [sourceId]/route.ts
│   ├── threads/
│   │   └── [thread_id]/
│   │       └── run/route.ts          ← Agent execution
│   └── [domain]/
│       └── route.ts                  ← More domains
│
└── health/route.ts                   ← Health check (no version)
```

**Rule:** Each `route.ts` should be <100 lines. If larger, extract logic into services.

---

## ✅ Testing Requirements

### Requirement 1: Valid Request Test

```typescript
describe("GET /api/v1/agents", () => {
  it("returns agents with 200 status", async () => {
    const response = await GET(mockRequest);
    
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("data");
    expect(Array.isArray(body.data)).toBe(true);
  });
});
```

### Requirement 2: Validation Error Test

```typescript
describe("POST /api/v1/agents", () => {
  it("returns 422 for invalid body", async () => {
    const request = mockRequest({ body: { name: "" } });  // Empty name
    const response = await POST(request);
    
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe("validation_error");
    expect(body.errors).toHaveProperty("name");
  });
});
```

### Requirement 3: Not Found Test

```typescript
describe("GET /api/v1/agents/[id]", () => {
  it("returns 404 when agent doesn't exist", async () => {
    const response = await GET(mockRequest, { params: { id: "nonexistent" } });
    
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("not_found");
  });
});
```

### Requirement 4: Error Handling Test

```typescript
describe("GET /api/v1/agents", () => {
  it("returns 500 on database error", async () => {
    mockListAgents.mockRejectedValueOnce(new Error("DB connection failed"));
    const response = await GET(mockRequest);
    
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("internal_error");
    expect(body.message).not.toContain("connection");  // No leaky details
  });
});
```

---

## ⚠️ Common Mistakes in This Module

### Mistake 1: Forget to Await Request Body Parse

```typescript
// ❌ BAD - Body not awaited
const body = request.json();
const payload = MySchema.parse(body);  // Parses Promise, not object!

// ✅ GOOD - Await the parse
const body = await request.json();
const payload = MySchema.parse(body);
```

### Mistake 2: Wrong Status Code for Resource Creation

```typescript
// ❌ BAD - Returns 200 for new resource
return NextResponse.json({ data: newAgent });  // Status = 200

// ✅ GOOD - Returns 201 for creation
return successResponse({ data: newAgent }, 201);
```

### Mistake 3: Inconsistent Error Response Format

```typescript
// ❌ BAD - Different formats
if (!valid) return NextResponse.json({ error: "Invalid" });
if (!found) return NextResponse.json({ message: "Not found" });

// ✅ GOOD - Consistent format
if (!valid) return errorResponse("validation_error", "Invalid", 422);
if (!found) return errorResponse("not_found", "Not found", 404);
```

### Mistake 4: Not Handling Parsing Errors

```typescript
// ❌ BAD - Crashes if JSON is malformed
const body = await request.json();  // Throws if not JSON

// ✅ GOOD - Handle parse errors
try {
  const body = await request.json();
  // ...
} catch (error) {
  return errorResponse("invalid_json", "Request body must be valid JSON", 400);
}
```

### Mistake 5: Using Direct NextResponse.json() Everywhere

```typescript
// ❌ BAD - Inconsistent responses
if (success) {
  return NextResponse.json({ agent });
} else if (notFound) {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

// ✅ GOOD - Use shared helpers
if (success) {
  return successResponse({ data: agent }, 200);
} else if (notFound) {
  return errorResponse("not_found", "Not found", 404);
}
```

---

## 📋 Alignment Checklist

Before opening a PR with API route changes:

### Response Format
- [ ] All success responses use `successResponse()` helper
- [ ] All error responses use `errorResponse()` or specific helpers
- [ ] Status codes match semantic meaning (201 for creation, 404 for not found)
- [ ] Response shape is consistent across all routes

### Input Validation
- [ ] Request body validated with Zod schema from `lib/api/contracts/*`
- [ ] Validation errors return 422 with field-level details
- [ ] Query params validated (if applicable)
- [ ] File uploads validated (if applicable)

### Error Handling
- [ ] All try/catch blocks return appropriate status codes
- [ ] Error messages are user-friendly (not stack traces)
- [ ] Business logic errors mapped to correct status codes (409, 422, 404, etc.)
- [ ] Unexpected errors return 500 with generic message
- [ ] Errors logged for debugging

### Type Safety
- [ ] Route params typed explicitly
- [ ] Request body type checked at compile time
- [ ] Response shape documented (JSDoc or `@type`)
- [ ] No use of `any` type

### Testing
- [ ] Happy path test passes
- [ ] Validation error test passes (422)
- [ ] Not found test passes (404)
- [ ] Error handling test passes (500)
- [ ] Test coverage >80%

### Code Quality
- [ ] Route file <100 lines (business logic extracted to services)
- [ ] No duplicate code (use shared helpers)
- [ ] No console.log() (use proper logging if needed)
- [ ] Middleware/hooks documented (if used)

### Documentation
- [ ] JSDoc comment describes endpoint (method, path, purpose)
- [ ] Input/output types documented
- [ ] Status codes documented
- [ ] Examples provided in comments

---

## 🔗 Related

- **Technical Debt:** See [TECHNICAL_DEBT_ANALYSIS.md](../../TECHNICAL_DEBT_ANALYSIS.md) § API Contract Drift
- **API Contracts:** See `lib/api/contracts/*` for shared request/response types
- **Response Helpers:** See `lib/api/responses.ts` for standard response functions
- **Modular Agent Strategy:** See [MODULAR_AGENT_STRATEGY.md](../../MODULAR_AGENT_STRATEGY.md)

---

**Questions?** See CONTRIBUTING.md or ask in code review.
