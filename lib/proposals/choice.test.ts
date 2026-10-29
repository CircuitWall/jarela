import { describe, expect, it } from "vitest";
import { choiceProposalSchema, choiceResponseSchema } from "./choice";

const question = {
  question: "Choose a format", options: [{ value: "brief", label: "Brief" }, { value: "full", label: "Full" }],
};

describe("choice proposal contracts", () => {
  it("requires bounded, distinct options", () => {
    expect(choiceProposalSchema.safeParse(question).success).toBe(true);
    expect(choiceProposalSchema.safeParse({ ...question, options: [question.options[0], question.options[0]] }).success).toBe(false);
    expect(choiceProposalSchema.safeParse({ ...question, options: [] }).success).toBe(false);
    expect(choiceProposalSchema.safeParse({ ...question, command: "not-an-action" }).success).toBe(false);
  });

  it.each([
    undefined, {}, { selected_values: [] }, { selected_values: ["invented"] },
    { selected_values: ["brief", "brief"] }, { selected_values: ["brief", "full"] },
    { selected_values: ["brief"], text: "Not enabled" },
  ])("rejects invalid single-choice answers: %j", (answer) => {
    expect(choiceResponseSchema(choiceProposalSchema.parse(question)).safeParse(answer).success).toBe(false);
  });

  it("supports offered multi-select and optional free text, including text-only answers", () => {
    const schema = choiceResponseSchema(choiceProposalSchema.parse({ ...question, multiple: true, allow_text: true }));
    expect(schema.parse({ selected_values: ["brief", "full"], text: " Both " })).toEqual({ selected_values: ["brief", "full"], text: "Both" });
    expect(schema.safeParse({ selected_values: [], text: "A different format" }).success).toBe(true);
  });
});
