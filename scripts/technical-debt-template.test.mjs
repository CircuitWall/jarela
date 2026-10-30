import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = parse(fs.readFileSync(path.join(root, ".github", "ISSUE_TEMPLATE", "technical-debt.yml"), "utf8"));

describe("technical debt issue form", () => {
  it("has unique field IDs and required actionable inputs", () => {
    expect(template.name).toBe("Technical Debt");
    const fields = template.body.filter((field) => field.type !== "markdown");
    expect(new Set(fields.map((field) => field.id)).size).toBe(fields.length);
    for (const id of ["category", "description", "location", "severity", "acceptance"]) {
      expect(fields.find((field) => field.id === id)?.validations?.required).toBe(true);
    }
    for (const field of fields) {
      expect(field.attributes.label).toEqual(expect.any(String));
      expect(field.attributes).not.toHaveProperty("validations");
    }
  });

  it("uses a valid default for severity and includes the approved function limit", () => {
    const category = template.body.find((field) => field.id === "category");
    expect(category.attributes.options).toContain("Function Complexity (150-line body ratchet)");
    const severity = template.body.find((field) => field.id === "severity");
    expect(severity.attributes.default).toBeGreaterThanOrEqual(0);
    expect(severity.attributes.default).toBeLessThan(severity.attributes.options.length);
  });
});
