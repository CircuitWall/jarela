import { describe, it, expect } from "vitest";
import { z } from "zod";
import { errorResponse, notFoundResponse, createdResponse, validateBody } from "./responses";
import type { NextRequest } from "next/server";

function fakeReq(body: unknown, opts?: { unparseable?: boolean }): NextRequest {
  return {
    json: async () => {
      if (opts?.unparseable) throw new SyntaxError("bad json");
      return body;
    },
  } as unknown as NextRequest;
}

describe("errorResponse", () => {
  it("returns JSON with status 400 by default", async () => {
    const r = errorResponse("oops");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "oops" });
  });

  it("respects the status override", async () => {
    const r = errorResponse("server boom", 500);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "server boom" });
  });
});

describe("notFoundResponse", () => {
  it("returns 404 with default message and code:not_found", async () => {
    const r = notFoundResponse();
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "Not found", code: "not_found" });
  });

  it("accepts a custom message and emits the code", async () => {
    const r = notFoundResponse("Agent not found");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "Agent not found", code: "not_found" });
  });
});

describe("createdResponse", () => {
  it("returns 201 with the body unchanged", async () => {
    const data = { id: "abc", name: "test" };
    const r = createdResponse(data);
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual(data);
  });
});

describe("validateBody", () => {
  const schema = z.object({ name: z.string().min(1) });

  it("returns parsed data when valid", async () => {
    const result = await validateBody(fakeReq({ name: "ok" }), schema);
    expect(result).toEqual({ name: "ok" });
  });

  it("returns a 400 NextResponse with the first issue when invalid", async () => {
    const result = await validateBody(fakeReq({ name: "" }), schema);
    expect(result).toMatchObject({ status: 400 });
    if (typeof result === "object" && "json" in result) {
      const body = await (result as Response).json();
      expect(body.error).toBeTruthy();
    }
  });

  it("returns a 400 when the request body isn't valid JSON", async () => {
    const result = await validateBody(fakeReq(undefined, { unparseable: true }), schema);
    expect(result).toMatchObject({ status: 400 });
    if (typeof result === "object" && "json" in result) {
      const body = await (result as Response).json();
      expect(body.error).toMatch(/JSON/i);
    }
  });
});
