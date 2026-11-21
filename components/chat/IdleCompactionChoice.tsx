"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { ChoiceProposal } from "@/lib/proposals/choice";
import { ChoiceRequestCard } from "@/components/proposals/ChoiceRequestCard";
import type { ChoiceResponse } from "@/components/proposals/ChoiceFields";

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
  hotMessageCount,
  onAnswer,
}: {
  open: boolean;
  busy: boolean;
  hotMessageCount: number;
  onAnswer: (value: string) => Promise<boolean>;
}) {
  const [response, setResponse] = useState<ChoiceResponse>({ selected_values: [] });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function applyChoice(value: string) {
    if (!value || submitting || busy) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!await onAnswer(value)) {
        setError("Could not apply your choice. The current context was kept; please try again.");
        setResponse({ selected_values: [] });
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <section
      aria-label="Idle compaction question"
      className="mx-4 mb-2 rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 text-xs"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert size={13} className="text-amber-700 dark:text-amber-400 shrink-0" />
        <span className="font-medium text-amber-800 dark:text-amber-200">
          This conversation has been idle for 3 hours
        </span>
        <span className="ml-auto opacity-70">{hotMessageCount} messages in the hot window</span>
      </div>
      <p className="my-1 text-fg-muted">
        Choosing Yes moves older messages into the bounded warm summary and keeps the latest topic available verbatim.
      </p>
      <ChoiceRequestCard
        proposal={PROPOSAL}
        response={response}
        onChange={(next) => {
          setResponse(next);
          setError(null);
        }}
        busy={busy || submitting}
        error={error}
        onSubmit={() => {
          const [value] = response.selected_values;
          if (value) void applyChoice(value);
        }}
        onDismiss={() => void applyChoice("keep")}
      />
      {busy && <p className="text-fg-muted">Wait for the current run or compaction to finish before responding.</p>}
    </section>
  );
}
