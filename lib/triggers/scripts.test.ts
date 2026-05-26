import { describe, it, expect, beforeEach } from "vitest";

const {
  registerScript,
  getScript,
  listScripts,
  __resetScriptRegistry,
} = await import("./scripts");

beforeEach(() => {
  __resetScriptRegistry();
});

describe("script registry (ADR-0028)", () => {
  it("registers and looks up a script", async () => {
    registerScript("test.echo", async (args) => ({ preview: `echo:${args.x}` }));
    const fn = getScript("test.echo");
    expect(fn).toBeDefined();
    const result = await fn!({ x: 1 });
    expect(result.preview).toBe("echo:1");
  });

  it("returns undefined for unknown names", () => {
    expect(getScript("does.not.exist")).toBeUndefined();
  });

  it("re-registering overwrites the previous function (idempotent)", async () => {
    registerScript("test.echo", async () => ({ preview: "first" }));
    registerScript("test.echo", async () => ({ preview: "second" }));
    expect(listScripts()).toEqual(["test.echo"]);
    const result = await getScript("test.echo")!({});
    expect(result.preview).toBe("second");
  });

  it("listScripts returns names sorted", () => {
    registerScript("z.late", async () => ({ preview: "z" }));
    registerScript("a.early", async () => ({ preview: "a" }));
    expect(listScripts()).toEqual(["a.early", "z.late"]);
  });
});
