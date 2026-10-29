"use client";

import type { ChoiceProposal } from "@/lib/proposals/choice";
import { useId } from "react";

export interface ChoiceResponse {
  selected_values: string[];
  text?: string;
}

export function ChoiceFields({ proposal, response, onChange, disabled }: {
  proposal: ChoiceProposal;
  response: ChoiceResponse;
  onChange: (response: ChoiceResponse) => void;
  disabled: boolean;
}) {
  const groupId = useId();
  return (
    <fieldset disabled={disabled} className="space-y-2 my-2">
      <legend className="font-medium text-fg">{proposal.question}</legend>
      {proposal.options.map((option) => (
        <label key={option.value} className="flex items-start gap-2 text-fg">
          <input
            type={proposal.multiple ? "checkbox" : "radio"}
            name={groupId}
            checked={response.selected_values.includes(option.value)}
            onChange={(event) => onChange({
              ...response,
              selected_values: proposal.multiple
                ? event.target.checked
                  ? [...response.selected_values, option.value]
                  : response.selected_values.filter((value) => value !== option.value)
                : [option.value],
            })}
          />
          {option.label}
        </label>
      ))}
      {proposal.allow_text && (
        <label className="block text-fg">
          Additional response (no secrets)
          <textarea
            value={response.text ?? ""}
            maxLength={4000}
            onChange={(event) => onChange({ ...response, text: event.target.value })}
            className="mt-1 w-full rounded border border-border bg-bg p-2 text-fg"
          />
        </label>
      )}
    </fieldset>
  );
}
