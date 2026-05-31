import { getDb } from "@/lib/db";
import { MBTI_PRESETS, type MbtiType } from "@/lib/agents/adaptive-persona-presets";

const now = () => new Date().toISOString();

export interface AgentConfigRow {
  id: string;
  name: string;
  icon: string | null;
  identity: string;
  instructions: string;
  tools: string;              // JSON string[]
  model_config_name: string | null;
  is_default: number;
  history_limit: number;        // 0 = unlimited
  history_window_hours: number; // 0 = no time bound
  never_reply: number;          // 1 = run the agent but don't auto-send replies via bridges
  adaptive_persona_enabled: number;  // 1 = use runtime mood/tone adaptation hints
  adaptive_persona_strength: number; // 0..100, how strongly to adapt to cues
  adaptive_empathy: number;          // 0..100, baseline empathetic tone
  adaptive_expressiveness: number;   // 0..100, restrained -> energetic
  adaptive_verbosity: number;        // 0..100, concise -> detailed
  adaptive_mbti: string;             // one of 16 MBTI types
  voice_enabled: number;             // 1 = expose mic/play UI for this agent
  voice_model: string;               // Gemini TTS model id
  voice_name: string;                // Gemini prebuilt voice name (Kore, Puck, …)
  voice_stt_model: string;           // Gemini multimodal model used for transcription
  voice_auto_speak: number;          // 1 = auto-play reply when user sent voice
  display_filters: string | null;    // JSON: Partial<DisplayFilters>; NULL = inherit defaults (ADR-0022)
  harness_id: string | null;         // ADR-0033: per-agent harness override; NULL = inherit global default
  delegate_targets: string | null;   // JSON string[] of agent ids this agent may delegate to; NULL/'[]' = none
  created_at: string;
  updated_at: string;
}

export function listAgentConfigs(): AgentConfigRow[] {
  return getDb()
    .prepare("SELECT * FROM agent_configs ORDER BY is_default DESC, created_at ASC")
    .all() as unknown as AgentConfigRow[];
}

export function getDefaultAgentConfig(): AgentConfigRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM agent_configs WHERE is_default=1 LIMIT 1")
      .get() as unknown as AgentConfigRow) ?? null
  );
}

export function getAgentConfig(id: string): AgentConfigRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM agent_configs WHERE id=?")
      .get(id) as unknown as AgentConfigRow) ?? null
  );
}

export interface UpsertAgentInput {
  id: string;
  name: string;
  icon?: string | null;
  identity: string;
  instructions: string;
  tools: string[];
  model_config_name?: string | null;
  is_default?: boolean;
  history_limit?: number;
  history_window_hours?: number;
  never_reply?: boolean;
  adaptive_persona_enabled?: boolean;
  adaptive_persona_strength?: number;
  adaptive_empathy?: number;
  adaptive_expressiveness?: number;
  adaptive_verbosity?: number;
  adaptive_mbti?: MbtiType;
  voice_enabled?: boolean;
  voice_model?: string;
  voice_name?: string;
  voice_stt_model?: string;
  voice_auto_speak?: boolean;
  harness_id?: string | null;
  delegate_targets?: string[];
}

/**
 * Parse the JSON-encoded delegate whitelist into a deduped string[]. Returns
 * an empty array for NULL, blank, or malformed JSON (delegation is opt-in).
 */
export function parseDelegateTargets(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
    return Array.from(new Set(ids));
  } catch {
    return [];
  }
}

export function upsertAgentConfig(input: UpsertAgentInput): AgentConfigRow {
  const t = now();
  const db = getDb();
  const existing = getAgentConfig(input.id);
  const created_at = existing?.created_at ?? t;
  const mbti = input.adaptive_mbti ?? toMbti(existing?.adaptive_mbti) ?? "INTJ";
  const preset = MBTI_PRESETS[mbti];
  const strength = input.adaptive_persona_strength ?? preset.strength;
  const empathy = input.adaptive_empathy ?? preset.empathy;
  const expressiveness = input.adaptive_expressiveness ?? preset.expressiveness;
  const verbosity = input.adaptive_verbosity ?? preset.verbosity;
  if (input.is_default) db.prepare("UPDATE agent_configs SET is_default=0").run();
  // harness_id: explicit `undefined` means "keep existing"; explicit `null`
  // means "use the global default". Empty string is normalised to null too,
  // matching how the AgentEditor sends "" for the inherit option.
  const harnessId =
    input.harness_id === undefined
      ? (existing?.harness_id ?? null)
      : (input.harness_id && input.harness_id.length > 0 ? input.harness_id : null);
  // delegate_targets: undefined = keep existing; explicit empty array clears.
  const delegateTargets = input.delegate_targets === undefined
    ? (existing?.delegate_targets ?? null)
    : JSON.stringify(Array.from(new Set(input.delegate_targets.filter((id) => id && id !== input.id))));
  db.prepare(
      `INSERT OR REPLACE INTO agent_configs
        (id, name, icon, identity, instructions, tools, model_config_name, is_default,
         history_limit, history_window_hours, never_reply,
         adaptive_persona_enabled, adaptive_persona_strength, adaptive_empathy, adaptive_expressiveness, adaptive_verbosity, adaptive_mbti,
         voice_enabled, voice_model, voice_name, voice_stt_model, voice_auto_speak,
         harness_id, delegate_targets,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.name,
      input.icon ?? null,
      input.identity,
      input.instructions,
      JSON.stringify(input.tools),
      input.model_config_name ?? null,
      input.is_default ? 1 : (existing?.is_default ?? 0),
      input.history_limit ?? existing?.history_limit ?? 50,
      input.history_window_hours ?? existing?.history_window_hours ?? 8,
      // never_reply is a boolean toggle — explicit `undefined` means "keep existing"
      // (important for PATCH-style updates that omit the field).
      input.never_reply === undefined
        ? (existing?.never_reply ?? 0)
        : (input.never_reply ? 1 : 0),
      input.adaptive_persona_enabled === undefined
        ? (existing?.adaptive_persona_enabled ?? 0)
        : (input.adaptive_persona_enabled ? 1 : 0),
      clampPercent(strength, existing?.adaptive_persona_strength ?? 50),
      clampPercent(empathy, existing?.adaptive_empathy ?? 50),
      clampPercent(expressiveness, existing?.adaptive_expressiveness ?? 50),
      clampPercent(verbosity, existing?.adaptive_verbosity ?? 50),
      mbti,
      input.voice_enabled === undefined
        ? (existing?.voice_enabled ?? 0)
        : (input.voice_enabled ? 1 : 0),
      (input.voice_model ?? existing?.voice_model ?? "gemini-2.5-flash-preview-tts").trim() ||
        "gemini-2.5-flash-preview-tts",
      (input.voice_name ?? existing?.voice_name ?? "Kore").trim() || "Kore",
      (input.voice_stt_model ?? existing?.voice_stt_model ?? "gemini-2.5-flash").trim() ||
        "gemini-2.5-flash",
      input.voice_auto_speak === undefined
        ? (existing?.voice_auto_speak ?? 1)
        : (input.voice_auto_speak ? 1 : 0),
      harnessId,
      delegateTargets,
      created_at,
      t,
    );
  return getAgentConfig(input.id)!;
}

function clampPercent(next: number | undefined, fallback: number): number {
  const n = Number.isFinite(next) ? Number(next) : fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toMbti(v: string | null | undefined): MbtiType | null {
  if (!v) return null;
  return (v in MBTI_PRESETS ? v : null) as MbtiType | null;
}

export function deleteAgentConfig(id: string): boolean {
  return (
    (getDb().prepare("DELETE FROM agent_configs WHERE id=?").run(id) as { changes: number }).changes > 0
  );
}

export function generateAgentId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return slug ? `${slug}-${suffix}` : `agent-${suffix}`;
}

// ── ADR-0022: per-agent message-channel display filters ─────────────────
// Canonical channel keys mirrored in `hooks/useMessageFilters.ts`. Kept
// in sync there by importing this constant — single source of truth.
export const DISPLAY_FILTER_KEYS = [
  "scheduled_task",
  "watcher",
  "bridge",
  "synthetic",
  "tool_use",
  "thinking",
] as const;
export type DisplayFilterKey = (typeof DISPLAY_FILTER_KEYS)[number];
export type DisplayFilters = Record<DisplayFilterKey, boolean>;

export const DISPLAY_FILTER_DEFAULTS: DisplayFilters = {
  scheduled_task: true,
  watcher: true,
  bridge: true,
  synthetic: true,
  tool_use: true,
  thinking: true,
};

function parseDisplayFilters(raw: string | null | undefined): DisplayFilters {
  if (!raw) return { ...DISPLAY_FILTER_DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<DisplayFilters>;
    // Merge over defaults so newly-added channels stay visible on old rows.
    return { ...DISPLAY_FILTER_DEFAULTS, ...parsed };
  } catch {
    return { ...DISPLAY_FILTER_DEFAULTS };
  }
}

export function getAgentDisplayFilters(id: string): DisplayFilters | null {
  const row = getAgentConfig(id);
  if (!row) return null;
  return parseDisplayFilters(row.display_filters);
}

/**
 * Merge a partial filter map into the agent's stored prefs. Pass `null` to
 * reset to defaults (clears the column). Safe against concurrent toggles
 * from multiple browser tabs because the merge happens server-side.
 */
export function updateAgentDisplayFilters(
  id: string,
  patch: Partial<DisplayFilters> | null,
): DisplayFilters | null {
  const row = getAgentConfig(id);
  if (!row) return null;
  if (patch === null) {
    getDb()
      .prepare("UPDATE agent_configs SET display_filters=NULL, updated_at=? WHERE id=?")
      .run(now(), id);
    return { ...DISPLAY_FILTER_DEFAULTS };
  }
  const current = parseDisplayFilters(row.display_filters);
  const next: DisplayFilters = { ...current };
  for (const k of DISPLAY_FILTER_KEYS) {
    if (k in patch && typeof patch[k] === "boolean") next[k] = patch[k] as boolean;
  }
  getDb()
    .prepare("UPDATE agent_configs SET display_filters=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(next), now(), id);
  return next;
}
