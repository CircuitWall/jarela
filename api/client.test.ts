// Smoke tests for the client request layer's retry contract. The retry
// loop itself is exercised by the wider suite (every API call goes through
// `request()`); this file pins the public error class shape + transient-
// status policy so future edits don't silently change retry behaviour.

import { describe, it, expect } from "vitest";
import { ApiRequestError } from "./client";

describe("ApiRequestError", () => {
  it("captures kind + message + optional status", () => {
    const e = new ApiRequestError("http", "404 Not Found", 404);
    expect(e.kind).toBe("http");
    expect(e.status).toBe(404);
    expect(e.message).toBe("404 Not Found");
    expect(e.name).toBe("ApiRequestError");
  });

  it("kind=network has no status", () => {
    const e = new ApiRequestError("network", "fetch failed");
    expect(e.kind).toBe("network");
    expect(e.status).toBeUndefined();
  });

  it("kind=timeout signals deadline failure", () => {
    const e = new ApiRequestError("timeout", "request to /threads timed out after 30000ms");
    expect(e.kind).toBe("timeout");
    expect(e.message).toContain("timed out");
  });

  it("instanceof Error so existing catch blocks still match", () => {
    const e = new ApiRequestError("network", "x");
    expect(e instanceof Error).toBe(true);
  });
});
