import { describe, it, expect } from "vitest";
import { validateManifest } from "./manifest";

const valid = {
  id: "atlassian",
  name: "Atlassian",
  summary: "Jira + Confluence integration.",
  category: "issue-tracker" as const,
  prerequisites: [
    { check: "credentials" as const, detail: "API token" },
  ],
  steps: [
    {
      id: "step1",
      title: "Configure",
      description: "Add credentials to Jarela.",
      proposes: "enable_integration" as const,
    },
  ],
  troubleshooting: [
    { when: "401 from Jira", say: "Token may have expired." },
  ],
};

describe("validateManifest", () => {
  it("passes a well-formed manifest through unchanged in shape", () => {
    const out = validateManifest(valid);
    expect(out.id).toBe("atlassian");
    expect(out.steps[0].proposes).toBe("enable_integration");
  });

  it("rejects manifests with an invalid id", () => {
    expect(() => validateManifest({ ...valid, id: "Atlassian" })).toThrow();
    expect(() => validateManifest({ ...valid, id: "1atlassian" })).toThrow();
    expect(() => validateManifest({ ...valid, id: "atlassian!" })).toThrow();
    expect(() => validateManifest({ ...valid, id: "" })).toThrow();
  });

  it("accepts both kebab-case and snake_case ids", () => {
    expect(() => validateManifest({ ...valid, id: "atlassian-pro" })).not.toThrow();
    expect(() => validateManifest({ ...valid, id: "jira_align" })).not.toThrow();
  });

  it("requires at least one step", () => {
    expect(() => validateManifest({ ...valid, steps: [] })).toThrow();
  });

  it("rejects unknown categories", () => {
    expect(() => validateManifest({ ...valid, category: "social" })).toThrow();
  });

  it("rejects unknown 'proposes' values", () => {
    const bad = { ...valid, steps: [{ ...valid.steps[0], proposes: "delete_universe" }] };
    expect(() => validateManifest(bad)).toThrow();
  });

  it("permits omitted optional fields (docs_url, proposes, verify)", () => {
    const minimal = {
      ...valid,
      prerequisites: [{ check: "env" as const, detail: "Set FOO=bar" }],
      steps: [{ id: "s1", title: "t", description: "d" }],
    };
    expect(() => validateManifest(minimal)).not.toThrow();
  });

  it("rejects malformed docs_url", () => {
    const bad = {
      ...valid,
      prerequisites: [{ check: "env" as const, detail: "x", docs_url: "not a url" }],
    };
    expect(() => validateManifest(bad)).toThrow();
  });
});
