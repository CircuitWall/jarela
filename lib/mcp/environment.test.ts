import { describe, expect, it } from "vitest";
import { mergeMcpEnvironment, validateMcpEnvironment } from "./environment";

describe("MCP environment editor values", () => {
  it("accepts portable environment names and empty values", () => {
    expect(validateMcpEnvironment([
      { name: "API_TOKEN", value: "secret" },
      { name: "OPTIONAL_VALUE", value: "" },
    ])).toBeNull();
  });

  it("rejects invalid and case-insensitive duplicate names", () => {
    expect(validateMcpEnvironment([{ name: "NOT-VALID", value: "x" }])).toMatch(/Invalid/);
    expect(validateMcpEnvironment([
      { name: "Path", value: "one" },
      { name: "PATH", value: "two" },
    ])).toMatch(/Duplicate/);
  });

  it("merges env rows without changing the other server spec fields", () => {
    expect(mergeMcpEnvironment(
      { command: "node", args: ["server.js"], env: { OLD: "value" } },
      [{ name: "API_TOKEN", value: "secret" }],
    )).toEqual({ command: "node", args: ["server.js"], env: { API_TOKEN: "secret" } });
  });

  it("removes an empty env map without disturbing the server spec", () => {
    expect(mergeMcpEnvironment({ command: "node", env: { OLD: "value" } }, [])).toEqual({ command: "node" });
  });
});