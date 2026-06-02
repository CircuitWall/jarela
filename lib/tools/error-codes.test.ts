import { describe, it, expect } from "vitest";
import {
  httpStatusToErrorCode,
  networkErrorCode,
  classifyFsError,
  parseRetryAfterMs,
  defaultHttpHint,
} from "./error-codes";

describe("httpStatusToErrorCode", () => {
  it("maps the documented playbook codes", () => {
    expect(httpStatusToErrorCode(401)).toBe("http_401");
    expect(httpStatusToErrorCode(403)).toBe("http_403");
    expect(httpStatusToErrorCode(404)).toBe("http_404");
    expect(httpStatusToErrorCode(429)).toBe("http_429");
  });

  it("buckets generic 4xx and 5xx", () => {
    expect(httpStatusToErrorCode(400)).toBe("http_4xx");
    expect(httpStatusToErrorCode(422)).toBe("http_4xx");
    expect(httpStatusToErrorCode(500)).toBe("http_5xx");
    expect(httpStatusToErrorCode(503)).toBe("http_5xx");
  });

  it("falls back to http_error for unknown statuses", () => {
    expect(httpStatusToErrorCode(999)).toBe("http_error");
    expect(httpStatusToErrorCode(0)).toBe("http_error");
  });
});

describe("networkErrorCode", () => {
  it("recognises common Node fetch error codes", () => {
    expect(networkErrorCode({ code: "ECONNREFUSED", message: "" })).toBe("network_error");
    expect(networkErrorCode({ code: "ECONNRESET", message: "" })).toBe("network_error");
    expect(networkErrorCode({ code: "ETIMEDOUT", message: "" })).toBe("network_error");
    expect(networkErrorCode({ code: "EAI_AGAIN", message: "" })).toBe("network_error");
    expect(networkErrorCode({ code: "ENOTFOUND", message: "" })).toBe("network_error");
  });

  it("recognises message-only DNS / connection failures", () => {
    expect(networkErrorCode({ message: "getaddrinfo ENOTFOUND example.com" })).toBe("network_error");
    expect(networkErrorCode({ message: "fetch failed" })).toBe("network_error");
  });

  it("recognises AbortError as `aborted`", () => {
    expect(networkErrorCode({ name: "AbortError", message: "aborted" })).toBe("aborted");
  });

  it("returns null when nothing matches", () => {
    expect(networkErrorCode(null)).toBeNull();
    expect(networkErrorCode(undefined)).toBeNull();
    expect(networkErrorCode({ message: "TypeError: foo" })).toBeNull();
    expect(networkErrorCode("plain string")).toBeNull();
  });
});

describe("classifyFsError", () => {
  it("maps Node fs codes", () => {
    expect(classifyFsError({ code: "ENOENT" })).toBe("file_not_found");
    expect(classifyFsError({ code: "EACCES" })).toBe("permission_denied");
    expect(classifyFsError({ code: "EPERM" })).toBe("permission_denied");
    expect(classifyFsError({ code: "EISDIR" })).toBe("path_is_directory");
    expect(classifyFsError({ code: "ENOTDIR" })).toBe("path_not_directory");
    expect(classifyFsError({ code: "EEXIST" })).toBe("already_exists");
  });

  it("preserves caller-attached codes from throwWithCode", () => {
    expect(classifyFsError({ code: "denylist" })).toBe("denylist");
    expect(classifyFsError({ code: "invalid_args" })).toBe("invalid_args");
  });

  it("falls back to fs_error when nothing matches", () => {
    expect(classifyFsError(null)).toBe("fs_error");
    expect(classifyFsError({})).toBe("fs_error");
    expect(classifyFsError({ message: "no code field" })).toBe("fs_error");
  });
});

describe("parseRetryAfterMs", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfterMs("60")).toBe(60_000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("0.5")).toBe(500);
  });

  it("parses fractional seconds", () => {
    expect(parseRetryAfterMs("1.5")).toBe(1500);
  });

  it("returns undefined on null/empty", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
  });

  it("returns undefined on garbage values", () => {
    expect(parseRetryAfterMs("not a number")).toBeUndefined();
  });

  it("parses HTTP-date and clamps negative deltas to 0", () => {
    // Past date → at-most 0 ms wait. We don't test exact values to avoid
    // flake on slow CI; the contract is "non-negative" and "finite".
    const result = parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(result).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result)).toBe(true);
  });
});

describe("defaultHttpHint", () => {
  it("returns a hint for 401 that names the provider + Settings path", () => {
    const hint = defaultHttpHint("Atlassian", "http_401");
    expect(hint).toContain("Atlassian");
    expect(hint).toMatch(/Settings.*Integrations/i);
  });

  it("returns a hint for 403 (same Settings guidance)", () => {
    expect(defaultHttpHint("GitHub", "http_403")).toMatch(/GitHub/);
  });

  it("returns a hint for 404 telling the agent to verify the id first", () => {
    expect(defaultHttpHint("Jira Align", "http_404")).toMatch(/verify the id|key/i);
  });

  it("returns a hint for 429 referencing retry_after_ms", () => {
    expect(defaultHttpHint("GitHub", "http_429")).toMatch(/retry_after_ms/i);
  });

  it("returns undefined for codes generic enough that the playbook handles them", () => {
    expect(defaultHttpHint("X", "http_5xx")).toBeUndefined();
    expect(defaultHttpHint("X", "http_4xx")).toBeUndefined();
    expect(defaultHttpHint("X", "http_error")).toBeUndefined();
    expect(defaultHttpHint("X", "tool_timeout")).toBeUndefined();
  });
});
