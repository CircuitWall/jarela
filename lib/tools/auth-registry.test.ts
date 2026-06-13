import { describe, it, expect, beforeEach } from "vitest";
import {
  setPackageAuthResolver,
  resolvePackageAuth,
  _clearPackageAuthResolvers,
  _listRegisteredPackageAuthIds,
} from "./auth-registry";

describe("auth-registry", () => {
  beforeEach(() => _clearPackageAuthResolvers());

  it("resolves a registered package's auth", () => {
    setPackageAuthResolver("github", () => ({ token: "ghp_test" }));
    expect(resolvePackageAuth<{ token: string }>("github")).toEqual({ token: "ghp_test" });
  });

  it("returns a descriptive error for an unknown package", () => {
    const r = resolvePackageAuth<{ token: string }>("never-registered");
    expect("error" in r ? r.error : "").toMatch(/never-registered/);
    expect("error" in r ? r.error : "").toMatch(/not registered/);
  });

  it("forwards the underlying resolver's error shape unchanged", () => {
    setPackageAuthResolver("github", () => ({ error: "configure github" }));
    expect(resolvePackageAuth("github")).toEqual({ error: "configure github" });
  });

  it("last registration for an id wins (hot-reload behaviour)", () => {
    setPackageAuthResolver("github", () => ({ token: "old" }));
    setPackageAuthResolver("github", () => ({ token: "new" }));
    expect(resolvePackageAuth<{ token: string }>("github")).toEqual({ token: "new" });
  });

  it("lists registered ids sorted", () => {
    setPackageAuthResolver("github", () => ({ token: "x" }));
    setPackageAuthResolver("atlassian", () => ({ token: "y" }));
    setPackageAuthResolver("jira_align", () => ({ token: "z" }));
    expect(_listRegisteredPackageAuthIds()).toEqual(["atlassian", "github", "jira_align"]);
  });
});
