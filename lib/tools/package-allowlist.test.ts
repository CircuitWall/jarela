import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  getEffectivePackageAllowlist,
  isPackageAllowed,
  publisherOf,
} from "./package-allowlist";

const ENV_KEY = "JARELA_PACKAGE_ALLOWLIST";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("publisherOf", () => {
  it("returns the scope for scoped packages", () => {
    expect(publisherOf("@langchain/community")).toBe("@langchain");
    expect(publisherOf("@langchain/community/tools/tavily_search")).toBe("@langchain");
    expect(publisherOf("@langchain/community@0.4.0")).toBe("@langchain");
  });

  it("returns the bare name for unscoped packages", () => {
    expect(publisherOf("langchain")).toBe("langchain");
    expect(publisherOf("some-pkg/subpath")).toBe("some-pkg");
    expect(publisherOf("some-pkg@1.2.3")).toBe("some-pkg");
  });
});

describe("isPackageAllowed", () => {
  it("allows default LangChain scope", () => {
    const d = isPackageAllowed("@langchain/community");
    expect(d.allowed).toBe(true);
    expect(d.publisher).toBe("@langchain");
    expect(d.matchedPrefix).toBe("@langchain/");
  });

  it("allows default CircuitWall scope", () => {
    expect(isPackageAllowed("@circuitwall/foo").allowed).toBe(true);
  });

  it("allows bare 'langchain' and its subpaths", () => {
    expect(isPackageAllowed("langchain").allowed).toBe(true);
    expect(isPackageAllowed("langchain/agents").allowed).toBe(true);
  });

  it("does NOT allow unknown publishers", () => {
    const d = isPackageAllowed("evil-pkg");
    expect(d.allowed).toBe(false);
    expect(d.matchedPrefix).toBeNull();
    expect(d.publisher).toBe("evil-pkg");
  });

  it("does NOT allow unknown scopes", () => {
    expect(isPackageAllowed("@other/foo").allowed).toBe(false);
  });

  it("honors JARELA_PACKAGE_ALLOWLIST env override", () => {
    process.env[ENV_KEY] = "@acme/, lodash";
    expect(isPackageAllowed("@acme/widget").allowed).toBe(true);
    expect(isPackageAllowed("lodash").allowed).toBe(true);
    expect(isPackageAllowed("lodash/fp").allowed).toBe(true);
    expect(isPackageAllowed("@other/foo").allowed).toBe(false);
  });
});

describe("getEffectivePackageAllowlist", () => {
  it("includes defaults plus env overrides", () => {
    process.env[ENV_KEY] = "@acme/";
    const list = getEffectivePackageAllowlist();
    expect(list).toContain("@langchain/");
    expect(list).toContain("@circuitwall/");
    expect(list).toContain("langchain");
    expect(list).toContain("@acme/");
  });
});
