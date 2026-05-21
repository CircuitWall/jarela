export type MbtiType =
  | "INTJ" | "INTP" | "ENTJ" | "ENTP"
  | "INFJ" | "INFP" | "ENFJ" | "ENFP"
  | "ISTJ" | "ISFJ" | "ESTJ" | "ESFJ"
  | "ISTP" | "ISFP" | "ESTP" | "ESFP";

export interface MbtiPreset {
  label: string;
  strength: number;
  empathy: number;
  expressiveness: number;
  verbosity: number;
}

// Presets are intentionally conservative: they shape tone while leaving
// truthfulness and execution behavior to core agent policies.
export const MBTI_PRESETS: Record<MbtiType, MbtiPreset> = {
  INTJ: { label: "Architect", strength: 55, empathy: 35, expressiveness: 30, verbosity: 45 },
  INTP: { label: "Logician", strength: 50, empathy: 35, expressiveness: 30, verbosity: 55 },
  ENTJ: { label: "Commander", strength: 65, empathy: 30, expressiveness: 45, verbosity: 40 },
  ENTP: { label: "Debater", strength: 60, empathy: 40, expressiveness: 60, verbosity: 50 },

  INFJ: { label: "Advocate", strength: 55, empathy: 75, expressiveness: 50, verbosity: 55 },
  INFP: { label: "Mediator", strength: 50, empathy: 80, expressiveness: 55, verbosity: 60 },
  ENFJ: { label: "Protagonist", strength: 65, empathy: 80, expressiveness: 70, verbosity: 55 },
  ENFP: { label: "Campaigner", strength: 60, empathy: 75, expressiveness: 75, verbosity: 60 },

  ISTJ: { label: "Logistician", strength: 50, empathy: 30, expressiveness: 25, verbosity: 40 },
  ISFJ: { label: "Defender", strength: 50, empathy: 70, expressiveness: 40, verbosity: 50 },
  ESTJ: { label: "Executive", strength: 60, empathy: 35, expressiveness: 45, verbosity: 40 },
  ESFJ: { label: "Consul", strength: 60, empathy: 80, expressiveness: 65, verbosity: 50 },

  ISTP: { label: "Virtuoso", strength: 50, empathy: 30, expressiveness: 30, verbosity: 35 },
  ISFP: { label: "Adventurer", strength: 50, empathy: 65, expressiveness: 55, verbosity: 45 },
  ESTP: { label: "Entrepreneur", strength: 60, empathy: 40, expressiveness: 70, verbosity: 40 },
  ESFP: { label: "Entertainer", strength: 60, empathy: 70, expressiveness: 80, verbosity: 50 },
};

export const MBTI_TYPES: MbtiType[] = Object.keys(MBTI_PRESETS) as MbtiType[];
