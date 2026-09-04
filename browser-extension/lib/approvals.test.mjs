import { describe, it, expect, vi } from "vitest";
import {
  STORAGE_KEY,
  normalizeHost,
  getApproval,
  setApproval,
  clearApproval,
  getAllApprovals,
  syncApprovalsWithAllowedHosts,
  gateCommand,
} from "./approvals.mjs";

function makeStorage(initial = {}) {
  let state = { ...initial };
  return {
    get: vi.fn().mockImplementation(async (key) => {
      if (key === undefined) return { ...state };
      if (typeof key === "string") return { [key]: state[key] };
      return Object.fromEntries(key.map((k) => [k, state[k]]));
    }),
    set: vi.fn().mockImplementation(async (patch) => {
      state = { ...state, ...patch };
    }),
    _state: () => state,
  };
}

describe("normalizeHost", () => {
  it("lowercases bare hostnames", () => {
    expect(normalizeHost("Example.COM")).toBe("example.com");
  });
  it("strips scheme/path/port", () => {
    expect(normalizeHost("https://Example.com:8080/foo/bar")).toBe("example.com");
  });
  it("returns null for empty / non-string", () => {
    expect(normalizeHost(""))
      .toBe(null);
    expect(normalizeHost(null)).toBe(null);
    expect(normalizeHost(42)).toBe(null);
  });
});

describe("approval CRUD", () => {
  it("returns undefined for an unknown host", async () => {
    const s = makeStorage();
    expect(await getApproval(s, "example.com")).toBeUndefined();
    expect(await getAllApprovals(s)).toEqual({});
  });

  it("persists set/get round-trips", async () => {
    const s = makeStorage();
    await setApproval(s, "Example.com", "always");
    expect(await getApproval(s, "example.com")).toBe("always");
    await setApproval(s, "evil.test", "denied");
    expect(await getAllApprovals(s)).toEqual({
      "example.com": "always",
      "evil.test": "denied",
    });
  });

  it("clearApproval removes a host", async () => {
    const s = makeStorage({ [STORAGE_KEY]: { "a.test": "always", "b.test": "denied" } });
    await clearApproval(s, "a.test");
    expect(await getAllApprovals(s)).toEqual({ "b.test": "denied" });
  });

  it("rejects invalid states / hosts", async () => {
    const s = makeStorage();
    await expect(setApproval(s, "", "always")).rejects.toThrow(/host/);
    await expect(setApproval(s, "x.test", "maybe")).rejects.toThrow(/state/);
  });

  it("ignores garbage entries when reading back", async () => {
    const s = makeStorage({ [STORAGE_KEY]: { "ok.test": "always", "broken.test": "weird", "": "always" } });
    expect(await getAllApprovals(s)).toEqual({ "ok.test": "always" });
  });
});

describe("syncApprovalsWithAllowedHosts", () => {
  it("mirrors persisted allowed-sites into local always approvals", async () => {
    const s = makeStorage();
    await syncApprovalsWithAllowedHosts(s, ["Example.com", "docs.example.com"]);
    expect(await getAllApprovals(s)).toEqual({
      "docs.example.com": "always",
      "example.com": "always",
    });
  });

  it("removes local always approvals that are no longer persisted", async () => {
    const s = makeStorage({ [STORAGE_KEY]: { "old.test": "always", "keep.test": "always" } });
    await syncApprovalsWithAllowedHosts(s, ["keep.test"]);
    expect(await getAllApprovals(s)).toEqual({ "keep.test": "always" });
  });

  it("does not overwrite explicit local denies", async () => {
    const s = makeStorage({ [STORAGE_KEY]: { "blocked.test": "denied" } });
    await syncApprovalsWithAllowedHosts(s, ["blocked.test"]);
    expect(await getAllApprovals(s)).toEqual({ "blocked.test": "denied" });
  });
});

describe("gateCommand", () => {
  it("returns deny when host cannot be derived", async () => {
    const s = makeStorage();
    const prompt = vi.fn();
    const r = await gateCommand({ storage: s, host: "", action: "click", prompt });
    expect(r.allow).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("dispatches silently when host is always-approved", async () => {
    const s = makeStorage({ [STORAGE_KEY]: { "ok.test": "always" } });
    const prompt = vi.fn();
    const r = await gateCommand({ storage: s, host: "ok.test", action: "click", prompt });
    expect(r).toEqual({ allow: true });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts for forcePrompt even when host is always-approved", async () => {
    const s = makeStorage({ [STORAGE_KEY]: { "ok.test": "always" } });
    const prompt = vi.fn().mockResolvedValue("once");
    const details = { level: "sensitive", reasons: ["reads the whole page"], force_prompt: true };
    const r = await gateCommand({
      storage: s,
      host: "ok.test",
      action: "extract",
      prompt,
      forcePrompt: true,
      promptDetails: details,
    });
    expect(r).toEqual({ allow: true });
    expect(prompt).toHaveBeenCalledWith({
      host: "ok.test",
      action: "extract",
      details,
      forcePrompt: true,
    });
  });

  it("rejects silently when host is denied", async () => {
    const s = makeStorage({ [STORAGE_KEY]: { "evil.test": "denied" } });
    const prompt = vi.fn();
    const r = await gateCommand({ storage: s, host: "evil.test", action: "click", prompt });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/denied/);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts on first use; 'once' dispatches without persisting", async () => {
    const s = makeStorage();
    const prompt = vi.fn().mockResolvedValue("once");
    const r = await gateCommand({ storage: s, host: "new.test", action: "click", prompt });
    expect(r.allow).toBe(true);
    expect(r.persisted).toBeUndefined();
    expect(await getApproval(s, "new.test")).toBeUndefined();
  });

  it("prompts on first use; 'always' dispatches and persists", async () => {
    const s = makeStorage();
    const prompt = vi.fn().mockResolvedValue("always");
    const r = await gateCommand({ storage: s, host: "new.test", action: "navigate", prompt });
    expect(r.allow).toBe(true);
    expect(r.persisted).toBe("always");
    expect(await getApproval(s, "new.test")).toBe("always");
  });

  it("prompts on first use; 'deny' rejects and persists", async () => {
    const s = makeStorage();
    const prompt = vi.fn().mockResolvedValue("deny");
    const r = await gateCommand({ storage: s, host: "new.test", action: "fill", prompt });
    expect(r.allow).toBe(false);
    expect(r.persisted).toBe("denied");
    expect(await getApproval(s, "new.test")).toBe("denied");
  });

  it("treats unknown choices as a soft dismiss", async () => {
    const s = makeStorage();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const r = await gateCommand({ storage: s, host: "new.test", action: "click", prompt });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/dismiss/);
    expect(await getApproval(s, "new.test")).toBeUndefined();
  });

  it("treats prompt errors as deny without persisting", async () => {
    const s = makeStorage();
    const prompt = vi.fn().mockRejectedValue(new Error("tab closed"));
    const r = await gateCommand({ storage: s, host: "new.test", action: "click", prompt });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/tab closed/);
    expect(await getApproval(s, "new.test")).toBeUndefined();
  });
});
