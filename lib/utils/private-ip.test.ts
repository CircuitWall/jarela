import { describe, it, expect } from "vitest";
import { classifyAddress, isPrivateAddress, checkPublicUrl } from "./private-ip";

describe("classifyAddress (IPv4)", () => {
  it("flags loopback", () => {
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
    expect(classifyAddress("127.255.255.254")).toBe("loopback");
  });
  it("flags RFC1918", () => {
    expect(classifyAddress("10.0.0.5")).toBe("private");
    expect(classifyAddress("172.16.1.1")).toBe("private");
    expect(classifyAddress("172.31.255.254")).toBe("private");
    expect(classifyAddress("192.168.1.1")).toBe("private");
  });
  it("does not flag 172.x outside the /12", () => {
    expect(classifyAddress("172.15.0.1")).toBe("public");
    expect(classifyAddress("172.32.0.1")).toBe("public");
  });
  it("flags link-local incl. metadata", () => {
    expect(classifyAddress("169.254.169.254")).toBe("link-local");
    expect(classifyAddress("169.254.0.1")).toBe("link-local");
  });
  it("flags CGNAT / tailnet", () => {
    expect(classifyAddress("100.64.0.1")).toBe("private");
    expect(classifyAddress("100.127.255.254")).toBe("private");
  });
  it("flags unspecified, multicast, broadcast", () => {
    expect(classifyAddress("0.0.0.0")).toBe("unspecified");
    expect(classifyAddress("224.0.0.1")).toBe("reserved");
    expect(classifyAddress("255.255.255.255")).toBe("reserved");
  });
  it("classifies normal public addresses", () => {
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("1.1.1.1")).toBe("public");
    expect(classifyAddress("99.63.255.255")).toBe("public");
    expect(classifyAddress("100.63.255.255")).toBe("public");
    expect(classifyAddress("100.128.0.1")).toBe("public");
  });
});

describe("classifyAddress (IPv6)", () => {
  it("flags loopback and link-local", () => {
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("fe80::1")).toBe("link-local");
    expect(classifyAddress("fe80::1%eth0")).toBe("link-local");
  });
  it("flags ULA", () => {
    expect(classifyAddress("fc00::1")).toBe("private");
    expect(classifyAddress("fd12:3456::1")).toBe("private");
  });
  it("flags IPv4-mapped per embedded v4", () => {
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::ffff:8.8.8.8")).toBe("public");
  });
  it("classifies public v6", () => {
    expect(classifyAddress("2001:4860:4860::8888")).toBe("public");
  });
});

describe("isPrivateAddress", () => {
  it("collapses every non-public classification to true", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });
});

describe("checkPublicUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    const r = await checkPublicUrl("file:///etc/passwd");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("unsupported-scheme");
  });
  it("rejects malformed URLs", async () => {
    const r = await checkPublicUrl("not a url");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("invalid-url");
  });
  it("rejects loopback literals", async () => {
    const r = await checkPublicUrl("http://127.0.0.1:4312/api/v1/threads");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("loopback");
  });
  it("rejects metadata literal", async () => {
    const r = await checkPublicUrl("http://169.254.169.254/latest/meta-data/");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("link-local");
  });
  it("rejects [::1] literal", async () => {
    const r = await checkPublicUrl("http://[::1]/");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("loopback");
  });
  it("honours the JARELA_ALLOW_PRIVATE_FETCH escape hatch", async () => {
    const prev = process.env.JARELA_ALLOW_PRIVATE_FETCH;
    process.env.JARELA_ALLOW_PRIVATE_FETCH = "1";
    try {
      const r = await checkPublicUrl("http://127.0.0.1:4312/");
      expect(r.allowed).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.JARELA_ALLOW_PRIVATE_FETCH;
      else process.env.JARELA_ALLOW_PRIVATE_FETCH = prev;
    }
  });
});
