import { describe, expect, it } from "vitest";
import { inspectSkillMetadata, parseSkillFrontmatter } from "./frontmatter";

const skill = (yaml: string, body = "# Example\n\nRead [the guide](references/REFERENCE.md).") => `---\n${yaml}\n---\n${body}`;
const valid = 'name: example\ndescription: "Use when: processing example data."';

describe("shared Agent Skills metadata", () => {
  it("parses standard YAML without mistaking nested host metadata for discovery fields", () => {
    const text = skill([
      valid, 'license: "Apache-2.0"', 'compatibility: "Requires Node 24"',
      'allowed-tools: "Read Bash(node:*)"', "metadata:", '  author: "Example author"',
      '  name: "not-the-skill"', '  description: "not-the-description"',
      '  version: "1.0"', "context: fork", "disable-model-invocation: true",
    ].join("\n"));
    const out = inspectSkillMetadata("example", text, "bundle");
    expect(out.status).toBe("extended");
    expect(out.metadata).toMatchObject({
      name: "example", description: "Use when: processing example data.",
      metadata: { name: "not-the-skill", description: "not-the-description", version: "1.0" },
      context: "fork", "disable-model-invocation": true,
    });
    expect(out.notices.map((issue) => issue.path)).toEqual([
      "context", "disable-model-invocation", "allowed-tools", "compatibility",
    ]);
    expect(out.execution_available).toBe(false);
    expect(out.limitation).toContain("not cross-host certification");
  });

  it("preserves YAML quoting, comments, Unicode and literal/folded string semantics", () => {
    expect(parseSkillFrontmatter(skill('name: example # comment\ndescription: "Say \\"hello\\" to caf\\u00e9."')).fields)
      .toEqual({ name: "example", description: 'Say "hello" to café.' });
    expect(parseSkillFrontmatter(skill("name: example\ndescription: 'It''s useful.'")).fields.description).toBe("It's useful.");
    expect(parseSkillFrontmatter(skill("name: example\ndescription: >-\n  Use this\n  for examples.")).fields.description)
      .toBe("Use this for examples.");
    expect(parseSkillFrontmatter(skill("name: example\ndescription: |\n  First line.\n  Second line.")).fields.description)
      .toBe("First line.\nSecond line.\n");
    expect(parseSkillFrontmatter("\uFEFF" + skill(valid).replace(/\n/g, "\r\n")).fields.name).toBe("example");
  });

  it("keeps the full standard description rather than the 200-character catalog preview", () => {
    const description = "x".repeat(1024);
    expect(inspectSkillMetadata("example", skill(`name: example\ndescription: ${description}`), "bundle"))
      .toMatchObject({ status: "standard", metadata: { description } });
  });

  it("matches the reference validator's Unicode naming and character-count rules", () => {
    for (const name of ["café", "代码", "ｓｋｉｌｌ"]) {
      expect(inspectSkillMetadata(name, skill(`name: ${name}\ndescription: ${"😀".repeat(1024)}`), "bundle").status)
        .toBe("standard");
    }
    expect(inspectSkillMetadata("é", skill("name: é\ndescription: useful"), "bundle").status).toBe("standard");
    expect(inspectSkillMetadata("É", skill("name: É\ndescription: useful"), "bundle").status).toBe("invalid");
    expect(inspectSkillMetadata("example", skill(`name: example\ndescription: ${"😀".repeat(1025)}`), "bundle").status)
      .toBe("invalid");
  });

  it.each([
    ["name: Wrong\ndescription: valid", "name"],
    ["name: example--skill\ndescription: valid", "name"],
    ["name: other\ndescription: valid", "name"],
    [`name: ${"x".repeat(65)}\ndescription: valid`, "name"],
    ["description: valid", "name"], ["name: example", "description"],
    ["name: example\ndescription: ''", "description"],
    ["name: example\ndescription: true", "description"],
    [`name: example\ndescription: ${"x".repeat(1025)}`, "description"],
    [valid + "\nlicense: []", "license"],
    [valid + "\nallowed-tools: [Read]", "allowed-tools"],
    [valid + `\ncompatibility: ${"x".repeat(501)}`, "compatibility"],
    [valid + "\nmetadata: [a, b]", "metadata"],
    [valid + "\nmetadata:\n  version: 1", "metadata"],
  ])("diagnoses invalid standard fields without rewriting instructions: %s", (yaml, field) => {
    const content = skill(yaml);
    const out = inspectSkillMetadata("example", content, "bundle");
    expect(out.status).toBe("invalid");
    expect(out.issues.some((issue) => issue.path === field)).toBe(true);
    expect(content).toBe(skill(yaml));
  });

  it.each([
    "---\nname: example", skill("- sequence"), skill(""), skill("name: [unclosed"),
    skill(valid + "\nname: duplicate"), skill(valid + "\ncustom: !execute command"),
    skill(valid + "\ncustom: &shared {a: b}\ncopy: *shared"),
    skill(valid + "\ncustom: .inf"), skill(valid + "\ncustom:\n  42: value"),
    skill(valid + "\ncustom: " + "[".repeat(40) + "0" + "]".repeat(40)),
    skill(valid + "\ncustom: [" + "0,".repeat(4096) + "0]"),
    skill(valid + "\n# " + "é".repeat(32768)),
  ])("reports malformed or excessive YAML as invalid, without executing anything", (content) => {
    expect(inspectSkillMetadata("example", content, "bundle")).toMatchObject({
      status: "invalid", execution_available: false, issues: [expect.objectContaining({ path: "frontmatter" })],
    });
  });

  it("keeps legacy layouts readable without claiming standard conformance", () => {
    expect(parseSkillFrontmatter("# Legacy\n\nDescription.")).toEqual({
      present: false, fields: {}, bodyStart: 0, issues: [],
    });
    expect(inspectSkillMetadata("example", "# Legacy", "bundle").status).toBe("legacy");
    expect(inspectSkillMetadata("example", skill(valid), null)).toMatchObject({
      status: "legacy", notices: [{ path: "layout", message: expect.stringContaining("no skill-root") }],
    });
  });
});
