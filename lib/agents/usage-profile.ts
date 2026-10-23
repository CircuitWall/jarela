export const USAGE_PROFILE_VALUES = ["home", "work", "dev", "custom"] as const;
export type UsageProfile = (typeof USAGE_PROFILE_VALUES)[number];

export interface PersonaStyle {
  strength: number;
  empathy: number;
  expressiveness: number;
  verbosity: number;
}

export const DEFAULT_PERSONA_STYLE: PersonaStyle = {
  strength: 50, empathy: 50, expressiveness: 50, verbosity: 50,
};

export const USAGE_PROFILES: Record<UsageProfile, {
  label: string;
  hint: string;
  compactChat: boolean;
  style: PersonaStyle | null;
  responseInstruction: string;
  citationStrictness: "off" | "standard" | "strict";
}> = {
  home: {
    label: "Home",
    hint: "Friendly summaries, chat-first layout, everyday integrations",
    compactChat: true,
    style: { strength: 40, empathy: 80, expressiveness: 65, verbosity: 25 },
    responseInstruction: "Lead with a short useful summary and the next action. Use approachable, plain language. Avoid technical jargon and routine diagnostic narration. Expand after the summary when asked, when troubleshooting needs it, or when risk or complexity requires it.",
    citationStrictness: "standard",
  },
  work: {
    label: "Work",
    hint: "Professional decisions, next steps, balanced detail",
    compactChat: true,
    style: { strength: 30, empathy: 55, expressiveness: 35, verbosity: 45 },
    responseInstruction: "Be professional and outcome-focused. Lead with the decision or result, then action items, owners and deadlines only when known. Separate decisions, assumptions, and open questions. Add rationale and tradeoffs where useful, not a routine execution log.",
    citationStrictness: "standard",
  },
  dev: {
    label: "Developer",
    hint: "Full diagnostics, evidence-backed claims, explicit validation",
    compactChat: false,
    style: { strength: 20, empathy: 30, expressiveness: 20, verbosity: 60 },
    responseInstruction: "Be precise and evidence-first. Ground every factual claim in observed tool results or provided sources. Distinguish observations from inferences, assumptions, and unknowns; assumptions do not substantiate factual claims. Name relevant files, commands, test results, validation limits, and reproducible next checks. Give a compact evidence summary when brevity is requested, not an unsupported conclusion.",
    citationStrictness: "strict",
  },
  custom: {
    label: "Custom / Everything",
    hint: "All integrations, full diagnostics, no added response-style rules",
    compactChat: false,
    style: null,
    responseInstruction: "No preset response organization. Follow the agent instructions, explicit user requests, and any enabled style controls.",
    citationStrictness: "off",
  },
};
