import { describe, it, expect } from "vitest";
import { friendlyErrorTitle } from "./error-message";

describe("friendlyErrorTitle", () => {
  it("falls back when error is null or unknown shape", () => {
    expect(friendlyErrorTitle(null, "Save failed")).toBe("Save failed");
    expect(friendlyErrorTitle({}, "Save failed")).toBe("Save failed");
    expect(friendlyErrorTitle("random text", "Save failed")).toBe("Save failed");
  });

  it("maps HTTP status from .status", () => {
    expect(friendlyErrorTitle({ status: 401 }, "X")).toBe("Not authorized");
    expect(friendlyErrorTitle({ status: 403 }, "X")).toBe("Not authorized");
    expect(friendlyErrorTitle({ status: 404 }, "X")).toBe("Not found");
    expect(friendlyErrorTitle({ status: 423 }, "X")).toBe("Locked");
    expect(friendlyErrorTitle({ status: 429 }, "X")).toBe("Too many requests");
    expect(friendlyErrorTitle({ status: 502 }, "X")).toBe("Server error");
  });

  it("maps HTTP status parsed from error message", () => {
    const err = new Error("Request failed (503 Service Unavailable)");
    expect(friendlyErrorTitle(err, "X")).toBe("Server error");
  });

  it("recognises abort errors", () => {
    expect(friendlyErrorTitle({ name: "AbortError" }, "X")).toBe("Cancelled");
    expect(friendlyErrorTitle({ code: "ABORT_ERR" }, "X")).toBe("Cancelled");
  });

  it("recognises network errors", () => {
    expect(friendlyErrorTitle(new TypeError("Failed to fetch"), "X")).toBe("Network unreachable");
    expect(friendlyErrorTitle({ code: "ECONNREFUSED" }, "X")).toBe("Network unreachable");
    expect(friendlyErrorTitle({ message: "fetch failed" }, "X")).toBe("Network unreachable");
  });

  it("uses fallback for unknown 4xx outside the named set", () => {
    expect(friendlyErrorTitle({ status: 418 }, "Save failed")).toBe("Request rejected");
  });
});
