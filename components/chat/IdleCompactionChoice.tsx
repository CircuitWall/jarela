"use client";

import { useState } from "react";
import type { ChoiceProposal } from "@/lib/proposals/choice";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ChoiceFields, type ChoiceResponse } from "@/components/proposals/ChoiceFields";

const PROPOSAL: ChoiceProposal = {
  question: "Would you like to compact this conversation now?",
  options: [
    { value: "compact", label: "Yes, compact and keep the latest topic hot" },
    { value: "keep", label: "No, keep the current context" },
  ],
  multiple: false,
  allow_text: false,
};

export function IdleCompactionChoice({
  open,
  busy,
  onAnswer,
}: {
  open: boolean;
  busy: boolean;
  onAnswer: (value: string) => Promise<boolean>;
}) {
  const [response, setResponse] = useState<ChoiceResponse>({ selected_values: [] });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const [value] = response.selected_values;
    if (!value || submitting || busy) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!await onAnswer(value)) {
        setError("Could not apply your choice. The current context was kept; please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => undefined}
      title="This conversation has been idle for 3 hours"
      dismissOnBackdrop={false}
      dismissOnEscape={false}
      showClose={false}
      footer={(
        <div className="flex justify-end px-4 pb-3">
          <Button
            disabled={busy || submitting || response.selected_values.length !== 1}
            onClick={() => void submit()}
          >
            {submitting ? "Applying…" : "Submit answer"}
          </Button>
        </div>
      )}
    >
      <p className="text-sm text-fg-muted">
        Choosing Yes moves older messages into the bounded warm summary and keeps the latest topic available verbatim.
      </p>
      <ChoiceFields
        proposal={PROPOSAL}
        response={response}
        onChange={(next) => {
          setResponse(next);
          setError(null);
        }}
        disabled={busy || submitting}
      />
      {busy && <p className="text-xs text-fg-muted">Wait for the current run or compaction to finish before responding.</p>}
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    </Dialog>
  );
}
