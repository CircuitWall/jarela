import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import { USAGE_PROFILES } from "@/lib/agents/usage-profile";

interface SignalSnapshot {
  mood: "frustrated" | "rushed" | "positive" | "neutral";
  urgency: number;
  frustration: number;
  positivity: number;
}

/**
 * Resolve profile organization and direct style controls into one turn-local
 * chapter. Legacy MBTI values deliberately have no effect.
 */
export function buildPersonaContext(agent: Pick<AgentConfigRow,
  "usage_profile" | "adaptive_persona_enabled" | "adaptive_persona_strength"
  | "adaptive_empathy" | "adaptive_expressiveness" | "adaptive_verbosity"
>, userMessage: string): string {
  const profile = USAGE_PROFILES[agent.usage_profile ?? "custom"];
  const base = [
    "--- Persona ---",
    `Profile: ${profile.label}`,
    "1. Use this resolved persona as a default, not a fixed reply template. Explicit user requests for detail take precedence. Follow Instruction composition; never infer a user's personality from this setting.",
    `2. ${profile.responseInstruction}`,
    "3. Keep required citations and source links even in a short answer. Never hide failures, uncertainty, material risks, or approval requests. Diagnostic visibility changes the UI only, not permissions, model context, or evidence requirements; it does not request private chain-of-thought.",
  ];
  if (!agent.adaptive_persona_enabled) {
    return [...base, "Style customization: off. Use the profile's organization without additional tone or detail targets."].join("\n");
  }

  const strength = clampPercent(agent.adaptive_persona_strength);
  const empathy = clampPercent(agent.adaptive_empathy);
  const expressiveness = clampPercent(agent.adaptive_expressiveness);
  const verbosity = clampPercent(agent.adaptive_verbosity);

  const signal: SignalSnapshot = strength > 0
    ? detectSignals(userMessage)
    : { mood: "neutral", urgency: 0, frustration: 0, positivity: 0 };
  const intensity = strength / 100;

  const targetEmpathy = clampPercent(
    empathy + Math.round((signal.frustration * 30 + signal.urgency * 10 - signal.positivity * 6) * intensity),
  );
  const targetExpressive = clampPercent(
    expressiveness + Math.round((signal.positivity * 24 - signal.frustration * 12) * intensity),
  );
  const targetVerbosity = clampPercent(
    verbosity + Math.round((signal.urgency * -30 + signal.frustration * -12) * intensity),
  );

  const empathyBand = bandLabel(targetEmpathy, [30, 70], ["low", "balanced", "high"]);
  const expressiveBand = bandLabel(targetExpressive, [30, 70], ["reserved", "balanced", "energetic"]);
  const verbosityBand = bandLabel(targetVerbosity, [30, 70], ["concise", "balanced", "detailed"]);

  const directives = [
    empathyBand === "high"
      ? "When the user expresses friction, acknowledge it briefly without delaying the answer-first opening."
      : empathyBand === "low"
        ? "Keep emotional language minimal; stay pragmatic and neutral."
        : "Use light empathy, then move quickly to actionable guidance.",
    verbosityBand === "concise"
      ? "Prefer short, direct answers and prioritize the next concrete action."
      : verbosityBand === "detailed"
        ? "Provide fuller rationale and tradeoffs when relevant."
        : "Keep explanations compact with enough rationale to be useful.",
    expressiveBand === "energetic"
      ? "Use lively but professional tone; avoid slang and exaggeration."
      : expressiveBand === "reserved"
        ? "Use calm, matter-of-fact wording."
        : "Use steady, approachable wording.",
    signal.mood === "rushed"
      ? "Possible urgency cue: front-load the answer and avoid unnecessary preamble."
      : signal.mood === "frustrated"
        ? "Possible friction cue: acknowledge briefly when relevant and offer a clear recovery path."
        : "Do not force mood mirroring; keep behavior stable and task-focused.",
  ];

  return [
    ...base,
    "Style customization: on. The following targets refine the profile's default opening and organization unless explicit task instructions override them.",
    "Verbosity targets are preferences, not minimum lengths. A detailed target expands relevant support after the opening; a concise target keeps required evidence, caveats, and requested depth. Style never lowers grounding or citation requirements.",
    "Conversational cues are keyword heuristics, not verified emotions or personality diagnoses. Use them lightly; do not claim to know the user's mood.",
    `Possible conversational cue: ${signal.mood}`,
    `Adapt strength: ${strength}/100`,
    `Target warmth: ${targetEmpathy}/100 (${empathyBand})`,
    `Target expressiveness: ${targetExpressive}/100 (${expressiveBand})`,
    `Target verbosity: ${targetVerbosity}/100 (${verbosityBand})`,
    "Style directives:",
    ...directives.map((d) => `- ${d}`),
    "Never sacrifice factual accuracy, safety policy, or execution completeness for style.",
  ].join("\n");
}

function detectSignals(text: string): SignalSnapshot {
  const lower = text.toLowerCase();

  const frustrationHits = countMatches(lower, [
    "stuck", "frustrat", "annoy", "angry", "wtf", "doesn't work", "not working", "broken", "hate this",
  ]);
  const urgencyHits = countMatches(lower, [
    "asap", "urgent", "quick", "quickly", "fast", "hurry", "right now", "immediately",
  ]);
  const positivityHits = countMatches(lower, [
    "thanks", "thank you", "awesome", "great", "love", "perfect", "nice",
  ]);

  const frustration = Math.min(1, frustrationHits / 2);
  const urgency = Math.min(1, urgencyHits / 2);
  const positivity = Math.min(1, positivityHits / 2);

  let mood: SignalSnapshot["mood"] = "neutral";
  if (frustration >= 0.5) mood = "frustrated";
  else if (urgency >= 0.5) mood = "rushed";
  else if (positivity >= 0.5) mood = "positive";

  return { mood, urgency, frustration, positivity };
}

function countMatches(text: string, terms: string[]): number {
  let n = 0;
  for (const term of terms) {
    if (text.includes(term)) n += 1;
  }
  return n;
}

function clampPercent(v: number): number {
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function bandLabel<T extends string>(value: number, cutoffs: [number, number], labels: [T, T, T]): T {
  if (value < cutoffs[0]) return labels[0];
  if (value > cutoffs[1]) return labels[2];
  return labels[1];
}
