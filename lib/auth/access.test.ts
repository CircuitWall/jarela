import { describe, it, expect, vi, beforeEach } from "vitest";

const isWhitelistedMock = vi.fn();
const touchLastSeenMock = vi.fn();

vi.mock("@/lib/stores/access", () => ({
  isWhitelisted: (...args: unknown[]) => isWhitelistedMock(...args),
  touchLastSeen: (...args: unknown[]) => touchLastSeenMock(...args),
}));

import {
  requireAccess,
  isLoopbackRequest,
  validateRequestOrigin,
} from "./access";

beforeEach(() => {
  isWhitelistedMock.mockReset();
  touchLastSeenMock.mockReset();
});

const headerBag = (h: Record<string, string>) => ({
  get: (n: string) => h[n.toLowerCase()] ?? null,
});

describe("requireAccess (tailscale identity)", () => {
  it("allows whitelisted tailscale identity and touches last-seen", () => {
    isWhitelistedMock.mockReturnValue(true);
    const r = requireAccess({
      headers: headerBag({ "tailscale-user-login": "alice@example.com" }),
      host: "ts.example.com",
    });
    expect(r).toEqual({ allowed: true, identity: "alice@example.com", reason: "whitelisted" });
    expect(touchLastSeenMock).toHaveBeenCalledWith("alice@example.com");
  });

  it("rejects non-whitelisted tailscale identity even when host looks loopback", () => {
    isWhitelistedMock.mockReturnValue(false);
    const r = requireAccess({
      headers: headerBag({ "tailscale-user-login": "mallory@example.com" }),
      host: "localhost:4312",
    });
    expect(r).toEqual({ allowed: false, identity: "mallory@example.com", reason: "not-whitelisted" });
    expect(touchLastSeenMock).not.toHaveBeenCalled();
  });
});

describe("requireAccess (loopback)", () => {
  it("allows when remoteAddress is 127.x", () => {
    const r = requireAccess({ headers: headerBag({}), host: null, remoteAddress: "127.0.0.1" });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("loopback");
  });

  it("allows ::1 IPv6 loopback", () => {
    const r = requireAccess({ headers: headerBag({}), host: null, remoteAddress: "::1" });
    expect(r.allowed).toBe(true);
  });

  it("falls back to host header loopback only when no remoteAddress is given", () => {
    const r = requireAccess({ headers: headerBag({}), host: "localhost:4312" });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("loopback");
  });

  it("rejects non-loopback remoteAddress with no identity", () => {
    const r = requireAccess({ headers: headerBag({}), host: null, remoteAddress: "10.0.0.5" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("no-identity");
  });

  it("works with a NodeHeaders-style record (no .get method)", () => {
    isWhitelistedMock.mockReturnValue(true);
    const r = requireAccess({
      headers: { "tailscale-user-login": "bob@x" },
      host: null,
    });
    expect(r.allowed).toBe(true);
    expect(r.identity).toBe("bob@x");
  });
});

describe("isLoopbackRequest", () => {
  it("returns true for localhost host header", () => {
    const req = new Request("http://localhost/", { headers: { host: "localhost:4312" } });
    expect(isLoopbackRequest(req)).toBe(true);
  });

  it("returns false for non-loopback host", () => {
    const req = new Request("http://example.com/", { headers: { host: "example.com" } });
    expect(isLoopbackRequest(req)).toBe(false);
  });
});

describe("validateRequestOrigin", () => {
  it("allows safe HTTP methods unconditionally", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      const r = validateRequestOrigin({ method: m, headers: headerBag({}), host: "h" });
      expect(r).toEqual({ allowed: true, reason: "safe-method" });
    }
  });

  it("allows non-browser callers with neither Origin nor Sec-Fetch-Site", () => {
    const r = validateRequestOrigin({ method: "POST", headers: headerBag({}), host: "localhost" });
    expect(r).toEqual({ allowed: true, reason: "no-headers" });
  });

  it("blocks cross-site Sec-Fetch-Site", () => {
    const r = validateRequestOrigin({
      method: "POST",
      headers: headerBag({ "sec-fetch-site": "cross-site" }),
      host: "localhost",
    });
    expect(r).toEqual({ allowed: false, reason: "cross-site" });
  });

  it("blocks Origin-host mismatch", () => {
    const r = validateRequestOrigin({
      method: "POST",
      headers: headerBag({ "sec-fetch-site": "same-origin", origin: "https://evil.com" }),
      host: "localhost:4312",
    });
    expect(r).toEqual({ allowed: false, reason: "origin-mismatch" });
  });

  it("allows matching Origin-host", () => {
    const r = validateRequestOrigin({
      method: "POST",
      headers: headerBag({ "sec-fetch-site": "same-origin", origin: "http://localhost:4312" }),
      host: "localhost:4312",
    });
    expect(r).toEqual({ allowed: true, reason: "same-origin" });
  });

  it("rejects malformed Origin", () => {
    const r = validateRequestOrigin({
      method: "POST",
      headers: headerBag({ "sec-fetch-site": "same-origin", origin: "not-a-url" }),
      host: "localhost",
    });
    expect(r).toEqual({ allowed: false, reason: "origin-mismatch" });
  });
});
