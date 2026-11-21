"use client";

import { Check, X } from "lucide-react";
import { choiceResponseSchema, type ChoiceProposal } from "@/lib/proposals/choice";
import { ChoiceFields, type ChoiceResponse } from "./ChoiceFields";

// The shared "ask the user" answer form: the same fields and Submit/Dismiss
// controls for agent `ask_choice` proposals and UI-owned questions.
export function ChoiceRequestCard({
  proposal,
  response,
  onChange,
  busy,
  error,
  submitLabel = "Submit response",
  dismissLabel = "Dismiss",
  onSubmit,
  onDismiss,
}: {
  proposal: ChoiceProposal;
  response: ChoiceResponse;
  onChange: (response: ChoiceResponse) => void;
  busy: boolean;
  error?: string | null;
  submitLabel?: string;
  dismissLabel?: string;
  onSubmit: () => void;
  onDismiss: () => void;
}) {
  const valid = choiceResponseSchema(proposal).safeParse(response).success;
  return (
    <>
      <ChoiceFields
        proposal={proposal}
        response={response}
        onChange={onChange}
        disabled={busy}
      />
      {error && <p role="alert" className="text-red-500">{error}</p>}
      <div className="flex gap-1.5 justify-end">
        <button
          onClick={onDismiss}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-subtle hover:text-fg hover:border-fg-faint disabled:opacity-50"
        >
          <X size={11} /> {dismissLabel}
        </button>
        <button
          onClick={onSubmit}
          disabled={busy || !valid}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
        >
          <Check size={11} /> {busy ? "Submitting…" : submitLabel}
        </button>
      </div>
    </>
  );
}
