import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import { MBTI_PRESETS, type MbtiType } from "@/lib/agents/adaptive-persona-presets";

interface SignalSnapshot {
  mood: "frustrated" | "rushed" | "positive" | "neutral";
  urgency: number;
  frustration: number;
  positivity: number;
}

/**
 * Build a compact runtime persona section from per-agent adaptive settings and
 * the current user message. This keeps adaptation deterministic and auditable.
 */
export function buildAdaptivePersonaContext(agent: AgentConfigRow, userMessage: string): string {
  if (!agent.adaptive_persona_enabled) return "";

  const mbti = toMbti(agent.adaptive_mbti) ?? "INTJ";
  const mbtiLabel = MBTI_PRESETS[mbti].label;

  const strength = clampPercent(agent.adaptive_persona_strength);
  const empathy = clampPercent(agent.adaptive_empathy);
  const expressiveness = clampPercent(agent.adaptive_expressiveness);
  const verbosity = clampPercent(agent.adaptive_verbosity);

  const signal = detectSignals(userMessage);
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
      ? "Acknowledge user friction clearly before giving steps."
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
      ? "User appears time-constrained; front-load the answer and avoid preamble."
      : signal.mood === "frustrated"
        ? "User appears frustrated; validate briefly and offer a clear recovery path."
        : "Do not force mood mirroring; keep behavior stable and task-focused.",
  ];

  return [
    "--- Adaptive persona ---",
    "These style constraints are dynamic and apply to this turn only.",
    `Preset: ${mbti} (${mbtiLabel})`,
    `Detected user signal: ${signal.mood}`,
    `Adapt strength: ${strength}/100`,
    `Target empathy: ${targetEmpathy}/100 (${empathyBand})`,
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

function toMbti(v: string | null | undefined): MbtiType | null {
  if (!v) return null;
  return (v in MBTI_PRESETS ? v : null) as MbtiType | null;
}
