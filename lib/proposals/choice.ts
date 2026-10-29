import { z } from "zod";

export const choiceProposalSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  options: z.array(z.object({
    value: z.string().trim().min(1).max(100),
    label: z.string().trim().min(1).max(500),
  }).strict()).min(2).max(12),
  multiple: z.boolean().default(false),
  allow_text: z.boolean().default(false),
}).strict().refine(
  ({ options }) => new Set(options.map((option) => option.value)).size === options.length,
  "Option values must be unique",
);

export type ChoiceProposal = z.infer<typeof choiceProposalSchema>;

export function choiceResponseSchema(proposal: ChoiceProposal) {
  return z.object({
    selected_values: z.array(z.string()).max(proposal.options.length),
    text: z.string().trim().max(4000).optional(),
  }).strict().superRefine(({ selected_values, text }, ctx) => {
    if (new Set(selected_values).size !== selected_values.length
      || selected_values.some((value) => !proposal.options.some((option) => option.value === value))) {
      ctx.addIssue({ code: "custom", message: "Select only the offered options, without duplicates" });
    }
    if (!proposal.multiple && selected_values.length > 1) {
      ctx.addIssue({ code: "custom", message: "Select only one option" });
    }
    if (text && !proposal.allow_text) {
      ctx.addIssue({ code: "custom", message: "Free-text responses are not enabled" });
    }
    if (selected_values.length === 0 && !text) {
      ctx.addIssue({ code: "custom", message: "A response is required" });
    }
  });
}
