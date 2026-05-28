import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import {
  CUSTOM_HARNESS_ID_PREFIX,
  DEFAULT_HARNESS_ID,
  HARNESS_SECTION_KEYS,
  type Harness,
  type HarnessSection,
  type HarnessSectionKey,
  isBuiltinHarnessId,
} from "@/lib/agents/harness/types";
import { BUILTIN_HARNESSES, getBuiltinHarness } from "@/lib/agents/harness/presets";

const NS = "app-settings";
const CUSTOMS_KEY = "harnesses";
const DEFAULT_KEY = "default_harness_id";

const now = () => new Date().toISOString();

function readJson<T>(key: string): T | null {
  const row = getDb()
    .prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?")
    .get(NS, key) as { value?: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const t = now();
  const existing = getDb()
    .prepare("SELECT created_at FROM memory_store WHERE namespace=? AND key=?")
    .get(NS, key) as { created_at?: string } | undefined;
  const created = existing?.created_at ?? t;
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)",
    )
    .run(NS, key, JSON.stringify(value), created, t);
}

function deleteKey(key: string): void {
  getDb().prepare("DELETE FROM memory_store WHERE namespace=? AND key=?").run(NS, key);
}

function sanitizeSections(input: unknown): Harness["sections"] {
  const out = {} as Harness["sections"];
  const obj = (input ?? {}) as Partial<Record<HarnessSectionKey, Partial<HarnessSection>>>;
  for (const k of HARNESS_SECTION_KEYS) {
    const s = obj[k] ?? { enabled: true, body: "" };
    out[k] = {
      enabled: s.enabled !== false,
      body: typeof s.body === "string" ? s.body : "",
    };
  }
  return out;
}

function listCustomHarnesses(): Harness[] {
  const raw = readJson<unknown[]>(CUSTOMS_KEY);
  if (!Array.isArray(raw)) return [];
  const out: Harness[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Partial<Harness>;
    if (typeof obj.id !== "string" || !obj.id.startsWith(CUSTOM_HARNESS_ID_PREFIX)) continue;
    if (typeof obj.name !== "string") continue;
    out.push({
      id: obj.id,
      name: obj.name,
      description: typeof obj.description === "string" ? obj.description : undefined,
      builtin: false,
      sections: sanitizeSections(obj.sections),
    });
  }
  return out;
}

function writeCustomHarnesses(list: Harness[]): void {
  writeJson(CUSTOMS_KEY, list);
}

export function listAllHarnesses(): Harness[] {
  return [...BUILTIN_HARNESSES, ...listCustomHarnesses()];
}

export function getHarness(id: string): Harness | null {
  if (isBuiltinHarnessId(id)) return getBuiltinHarness(id) ?? null;
  return listCustomHarnesses().find((h) => h.id === id) ?? null;
}

export function getDefaultHarnessId(): string {
  const raw = readJson<string>(DEFAULT_KEY);
  if (typeof raw === "string" && raw.length > 0) return raw;
  return DEFAULT_HARNESS_ID;
}

export function setDefaultHarnessId(id: string): string {
  if (!getHarness(id)) {
    throw new Error(`unknown harness id: ${id}`);
  }
  if (id === DEFAULT_HARNESS_ID) {
    deleteKey(DEFAULT_KEY);
    return DEFAULT_HARNESS_ID;
  }
  writeJson(DEFAULT_KEY, id);
  return id;
}

export interface CreateHarnessInput {
  name: string;
  description?: string;
  sections: Partial<Record<HarnessSectionKey, Partial<HarnessSection>>>;
}

export function createCustomHarness(input: CreateHarnessInput): Harness {
  const id = `${CUSTOM_HARNESS_ID_PREFIX}${randomUUID()}`;
  const harness: Harness = {
    id,
    name: input.name.trim() || "Untitled harness",
    description: input.description?.trim() || undefined,
    builtin: false,
    sections: sanitizeSections(input.sections),
  };
  const list = listCustomHarnesses();
  list.push(harness);
  writeCustomHarnesses(list);
  return harness;
}

export interface UpdateHarnessInput {
  name?: string;
  description?: string;
  sections?: Partial<Record<HarnessSectionKey, Partial<HarnessSection>>>;
}

export function updateCustomHarness(id: string, input: UpdateHarnessInput): Harness | null {
  if (isBuiltinHarnessId(id)) return null;
  const list = listCustomHarnesses();
  const idx = list.findIndex((h) => h.id === id);
  if (idx === -1) return null;
  const prev = list[idx];
  const next: Harness = {
    ...prev,
    name: input.name !== undefined ? (input.name.trim() || prev.name) : prev.name,
    description:
      input.description !== undefined
        ? (input.description.trim() || undefined)
        : prev.description,
    sections: input.sections ? sanitizeSections({ ...prev.sections, ...input.sections }) : prev.sections,
  };
  list[idx] = next;
  writeCustomHarnesses(list);
  return next;
}

export function deleteCustomHarness(id: string): boolean {
  if (isBuiltinHarnessId(id)) return false;
  const list = listCustomHarnesses();
  const next = list.filter((h) => h.id !== id);
  if (next.length === list.length) return false;
  writeCustomHarnesses(next);
  // Null out any agent that referenced this harness so resolveHarness falls
  // back to the global default rather than the deleted id.
  getDb()
    .prepare("UPDATE agent_configs SET harness_id=NULL, updated_at=? WHERE harness_id=?")
    .run(now(), id);
  // If this harness was the global default, fall back to builtin:default.
  if (getDefaultHarnessId() === id) {
    deleteKey(DEFAULT_KEY);
  }
  return true;
}
