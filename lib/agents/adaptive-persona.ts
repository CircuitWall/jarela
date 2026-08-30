import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import { MBTI_PRESETS, type MbtiType } from "@/lib/agents/adaptive-persona-presets";

interface SignalSnapshot {
  mood: "frustrated" | "rushed" | "positive" | "neutral";
  urgency: number;
  frustration: number;
  positivity: number;
}

interface PersonaAxes {
  decision: "analytical" | "exploratory" | "directive" | "supportive";
  interaction: "independent" | "collaborative";
  structure: "linear" | "flexible";
  evidence: "high" | "balanced";
}

/**
 * Build a compact runtime persona section from per-agent adaptive settings and
 * the current user message. This keeps adaptation deterministic and auditable.
 */
export function buildAdaptivePersonaContext(agent: AgentConfigRow, userMessage: string): string {
  if (!agent.adaptive_persona_enabled) return "";

  const mbti = toMbti(agent.adaptive_mbti) ?? "INTJ";
  const mbtiLabel = MBTI_PRESETS[mbti].label;
  const axes = personaAxes(mbti);

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

  const operatingContract = buildOperatingContract({
    axes,
    signal,
    empathyBand,
    expressiveBand,
    verbosityBand,
    strength,
  });

  return [
    "--- Adaptive persona ---",
    "These runtime behavior constraints are dynamic and apply to this turn only.",
    `Preset: ${mbti} (${mbtiLabel})`,
    `Behavior profile: ${axes.decision}, ${axes.interaction}, ${axes.structure}, evidence=${axes.evidence}`,
    `Detected user signal: ${signal.mood}`,
    `Adapt strength: ${strength}/100`,
    `Target empathy: ${targetEmpathy}/100 (${empathyBand})`,
    `Target expressiveness: ${targetExpressive}/100 (${expressiveBand})`,
    `Target verbosity: ${targetVerbosity}/100 (${verbosityBand})`,
    "Style directives:",
    ...directives.map((d) => `- ${d}`),
    "Operating contract:",
    ...operatingContract.map((d) => `- ${d}`),
    "Never sacrifice factual accuracy, safety policy, or execution completeness for style.",
  ].join("\n");
}

function buildOperatingContract(input: {
  axes: PersonaAxes;
  signal: SignalSnapshot;
  empathyBand: string;
  expressiveBand: string;
  verbosityBand: string;
  strength: number;
}): string[] {
  const { axes, signal, empathyBand, expressiveBand, verbosityBand, strength } = input;
  const lines: string[] = [];

  if (axes.decision === "analytical") {
    lines.push("Prefer explicit assumptions, constraints, and falsifiable next checks before conclusions.");
  } else if (axes.decision === "exploratory") {
    lines.push("Offer two or three viable paths when the problem is open-ended, then choose one and proceed.");
  } else if (axes.decision === "directive") {
    lines.push("Give a clear recommendation early, then list risks or exceptions briefly.");
  } else {
    lines.push("Anchor on the user's goal and emotional context before proposing the next action.");
  }

  if (axes.interaction === "collaborative") {
    lines.push("Use collaborative language and invite correction when assumptions are uncertain.");
  } else {
    lines.push("Stay self-directed: make reasonable decisions without asking unless the choice materially changes outcome or risk.");
  }

  if (axes.structure === "linear") {
    lines.push("Use ordered, stepwise structure for multi-step answers; avoid jumping between topics.");
  } else {
    lines.push("Use flexible grouping: summarize first, then expand only where it helps the current task.");
  }

  if (axes.evidence === "high") {
    lines.push("Prefer concrete evidence, file names, commands, outputs, or measured behavior over impressions.");
  } else {
    lines.push("Balance evidence with readability; keep proof points compact unless the user asks for depth.");
  }

  if (signal.mood === "frustrated" && empathyBand === "high") {
    lines.push("Do not over-explain the mistake; name the recovery path and take the next useful action quickly.");
  }
  if (signal.mood === "rushed" || verbosityBand === "concise") {
    lines.push("Use a short answer-first opening, then details only after the key action/result.");
  }
  if (signal.mood === "positive" && expressiveBand === "energetic") {
    lines.push("Keep the momentum, but do not add celebratory filler or widen scope unnecessarily.");
  }
  if (strength >= 80) {
    lines.push("Let this adaptive profile noticeably shape organization and phrasing, while keeping task policy dominant.");
  }
  return lines;
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

function personaAxes(mbti: MbtiType): PersonaAxes {
  const introverted = mbti[0] === "I";
  const intuitive = mbti[1] === "N";
  const thinking = mbti[2] === "T";
  const judging = mbti[3] === "J";

  let decision: PersonaAxes["decision"];
  if (thinking && judging) decision = "directive";
  else if (thinking && !judging) decision = "analytical";
  else if (!thinking && intuitive) decision = "exploratory";
  else decision = "supportive";

  return {
    decision,
    interaction: introverted ? "independent" : "collaborative",
    structure: judging ? "linear" : "flexible",
    evidence: thinking || judging ? "high" : "balanced",
  };
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
