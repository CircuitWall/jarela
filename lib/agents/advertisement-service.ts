import { createHash, randomUUID } from "node:crypto";
import { getAgentConfig, listAgentConfigs, type AgentConfigRow } from "@/lib/stores/agent-configs";
import {
  getAdvertisement, putAdvertisement, getAdvertisementPolicy, setAdvertisementPolicy, reserveAdvertisementCall,
} from "@/lib/stores/agent-advertisements";
import { getAllToolCatalogAsync, authorizedAgentToolNames, type ToolCatalogEntry } from "@/lib/tools";
import { getModelConfig, getModelParams, isModelConfigEnabled } from "@/lib/stores/model-config";
import { getProvider } from "@/lib/providers";
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import { SECRET_PATTERNS } from "../../scripts/lib/secret-patterns.mjs";
import {
  ADVERTISEMENT_CONTRACT_VERSION, AdvertisementSchema, AdvertisementPolicySchema,
  type Advertisement, type AdvertisementPolicy, type AdvertisementState,
} from "./advertisement-contract";
import { buildAdvertisementMessages } from "./advertisement-prompt";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function policyFingerprint(policy: AdvertisementPolicy): string {
  const model = policy.model_config_name ? getModelConfig(policy.model_config_name) : null;
  return hash({ policy, model: model ? { provider: model.provider, model_id: model.model_id, enabled: model.enabled } : null });
}
type Snapshot = { agent: AgentConfigRow; source: { name: string; identity: string; instructions: string; authorized_tools: { name: string; description: string; capability: string }[] }; fingerprint: string; knownTools: string[] };
function snapshot(agent: AgentConfigRow, catalog: readonly ToolCatalogEntry[]): Snapshot {
  const allowed = new Set(authorizedAgentToolNames(catalog, agent));
  const source = {
    name: agent.name, identity: agent.identity, instructions: agent.instructions,
    authorized_tools: catalog.filter((tool) => allowed.has(tool.name))
      .sort((a, b) => a.name.localeCompare(b.name)).map((tool) => ({
        name: tool.name, description: tool.description.slice(0, 80), capability: tool.capability,
      })),
  };
  const metadata = catalog.filter((tool) => allowed.has(tool.name)).sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({ name: tool.name, description: tool.description, capability: tool.capability, category: tool.category, source: tool.source }));
  return { agent, source, fingerprint: hash({ version: ADVERTISEMENT_CONTRACT_VERSION, source, metadata }), knownTools: catalog.map((tool) => tool.name) };
}
export function validateAdvertisement(value: unknown, source: Snapshot["source"], knownTools: readonly string[] = []): Advertisement {
  const checked = AdvertisementSchema.parse(value);
  const serialized = JSON.stringify(checked);
  if (SECRET_PATTERNS.some(({ re }) => re.test(serialized))
    || /(?:https?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:api[_-]?key|password|token|secret)\s*[:=])/i.test(serialized)) {
    throw new Error("output_privacy_refused");
  }
  const allowed = new Set(source.authorized_tools.map((tool) => tool.name));
  const prose = [checked.purpose, ...checked.call_when, ...checked.do_not_call_for, checked.inputs, checked.output].join(" ");
  if (/\b(?:ignore (?:all|previous|prior)|system prompt|delegate every|always delegate|bypass (?:approval|permission))\b/i.test(prose)) {
    throw new Error("output_instruction_refused");
  }
  if (checked.tools.some((name) => !allowed.has(name))
    || (prose.match(/\b[a-z][a-z0-9]*(?:[_.:][a-z0-9_-]+)+\b/g) ?? []).some((name) => !allowed.has(name))
    || knownTools.some((name) => !allowed.has(name)
      && new RegExp(`(^|[^a-zA-Z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-zA-Z0-9_])`, "i").test(prose))) {
    throw new Error("output_capability_refused");
  }
  const instructions = `${source.identity}\n${source.instructions}`.toLowerCase();
  for (const field of [checked.purpose, ...checked.call_when, ...checked.do_not_call_for, checked.inputs, checked.output]) {
    const words = field.toLowerCase().split(/\s+/);
    for (let i = 0; i + 6 <= words.length; i++) {
      const span = words.slice(i, i + 6).join(" ");
      if (span.length >= 32 && instructions.includes(span)) throw new Error("output_source_copy_refused");
    }
  }
  return checked;
}

interface Job { id: string; snapshot: Snapshot; policy: AdvertisementPolicy; policyFingerprint: string }
type Generator = (job: Job, signal: AbortSignal) => Promise<unknown>;
async function generate(job: Job, signal: AbortSignal): Promise<unknown> {
  const model = job.policy.model_config_name ? getModelConfig(job.policy.model_config_name) : null;
  if (!model || !isModelConfigEnabled(model)) throw new Error("model_unavailable");
  const provider = getProvider(model.provider);
  if (!provider) throw new Error("provider_unavailable");
  const { stream } = await provider.chat(model.model_id, buildAdvertisementMessages(job.snapshot.source),
    { ...getModelParams(model), temperature: 0, max_tokens: job.policy.max_output_tokens }, signal);
  let output = "";
  for await (const chunk of stream) {
    if (signal.aborted) throw new Error("generation_cancelled");
    if (output.length + chunk.length > 4096) throw new Error("output_size_refused");
    output += chunk;
  }
  return JSON.parse(output);
}
export class AdvertisementService {
  private queue = new Map<string, Job>();
  private work: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private activeId: string | null = null;
  private closed = false;
  constructor(private readonly generator: Generator = generate, private readonly catalog = getAllToolCatalogAsync) {}

  async inspect(agentId: string): Promise<AdvertisementState | null> {
    return this.refresh(agentId);
  }
  async refresh(agentId: string, force = false, suppliedCatalog?: readonly ToolCatalogEntry[]): Promise<AdvertisementState | null> {
    let agent = getAgentConfig(agentId);
    if (!agent) { this.queue.delete(agentId); return null; }
    let policy = getAdvertisementPolicy();
    let fingerprint = policyFingerprint(policy);
    let prior = getAdvertisement(agentId);
    if (!policy.enabled || prior?.enabled === false) {
      const disabled: AdvertisementState = {
        version: 1, generation_id: randomUUID(), agent_id: agentId, enabled: prior?.enabled ?? true,
        status: "disabled", source_fingerprint: "", policy_fingerprint: fingerprint,
        advertisement: null, error: null, updated_at: new Date().toISOString(),
      };
      this.queue.delete(agentId);
      if (prior?.status !== "disabled" || prior.policy_fingerprint !== fingerprint) putAdvertisement(disabled);
      return getAdvertisement(agentId);
    }
    const catalog = suppliedCatalog ?? await this.catalog();
    agent = getAgentConfig(agentId);
    if (!agent) return null;
    policy = getAdvertisementPolicy();
    fingerprint = policyFingerprint(policy);
    prior = getAdvertisement(agentId);
    if (!policy.enabled || prior?.enabled === false) return this.refresh(agentId, false, catalog);
    const current = snapshot(agent, catalog);
    if (!force && prior?.status === "pending" && prior.source_fingerprint === current.fingerprint
      && prior.policy_fingerprint === fingerprint && prior.generation_id !== this.activeId
      && this.queue.get(agentId)?.id !== prior.generation_id) {
      putAdvertisement({ ...prior, status: "failed", error: "generation_interrupted", advertisement: null });
      return getAdvertisement(agentId);
    }
    if (!force && prior?.source_fingerprint === current.fingerprint
      && prior.policy_fingerprint === fingerprint && prior.status !== "stale") {
      if (prior.status === "ready") {
        try { validateAdvertisement(prior.advertisement, current.source, current.knownTools); }
        catch {
          putAdvertisement({ ...prior, status: "failed", advertisement: null, error: "output_revalidation_refused" });
          return getAdvertisement(agentId);
        }
      }
      return prior;
    }
    const pending: AdvertisementState = {
      version: 1, generation_id: randomUUID(), agent_id: agentId, enabled: true,
      status: "pending", source_fingerprint: current.fingerprint, policy_fingerprint: fingerprint,
      advertisement: null, error: null, updated_at: new Date().toISOString(),
    };
    const serialized = JSON.stringify(current.source);
    const hasCredentials = SECRET_PATTERNS.some(({ re }) => re.test(serialized))
      || /\b(?:password|api[_-]?key|client_secret|refresh_token|access_token)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{8,}/i.test(serialized);
    if (this.closed || this.queue.size >= 256 || serialized.length > policy.max_input_chars || hasCredentials) {
      putAdvertisement({ ...pending, status: "failed", error: this.closed ? "service_closed" : this.queue.size >= 256 ? "queue_limit" : hasCredentials ? "source_credentials_refused" : "source_size_refused" });
      return getAdvertisement(agentId);
    }
    putAdvertisement(pending);
    this.queue.set(agentId, { id: pending.generation_id, snapshot: current, policy, policyFingerprint: fingerprint });
    this.drain();
    return getAdvertisement(agentId);
  }
  async configure(policy: AdvertisementPolicy): Promise<void> {
    const checked = AdvertisementPolicySchema.parse(policy);
    if (checked.enabled) {
      const model = checked.model_config_name ? getModelConfig(checked.model_config_name) : null;
      if (!model || !isModelConfigEnabled(model)) throw new Error("Select an existing enabled model config");
    }
    const changed = hash(getAdvertisementPolicy()) !== hash(checked);
    setAdvertisementPolicy(checked);
    if (changed) this.controller?.abort();
    for (const agent of listAgentConfigs()) await this.refresh(agent.id);
  }
  async setEnabled(agentId: string, enabled: boolean): Promise<AdvertisementState | null> {
    const prior = getAdvertisement(agentId);
    if (!getAgentConfig(agentId)) throw new Error("Agent not found");
    if (!enabled && prior?.generation_id === this.activeId) this.controller?.abort();
    const base: AdvertisementState = prior ?? {
      version: 1, generation_id: "", agent_id: agentId, enabled, status: "stale",
      source_fingerprint: "", policy_fingerprint: "", advertisement: null, error: null, updated_at: new Date().toISOString(),
    };
    putAdvertisement({ ...base, enabled, advertisement: null, status: enabled ? "stale" : "disabled", generation_id: randomUUID() });
    return this.refresh(agentId);
  }
  private drain(): void {
    if (this.work || this.closed) return;
    this.work = this.runQueue().catch(() => console.warn("[advertisements] worker failed"))
      .finally(() => { this.work = null; if (this.queue.size && !this.closed) this.drain(); });
  }
  private async runQueue(): Promise<void> {
    // Let rapid synchronous saves replace the queued revision before spending a call.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    while (this.queue.size && !this.closed) {
      const [agentId, job] = this.queue.entries().next().value!;
      this.queue.delete(agentId);
      const currentCatalog = await this.catalog();
      if (this.closed) return;
      const state = getAdvertisement(agentId);
      const currentAgent = getAgentConfig(agentId);
      if (!state || state.generation_id !== job.id || !state.enabled || !currentAgent) continue;
      if (state.status !== "pending" || policyFingerprint(getAdvertisementPolicy()) !== job.policyFingerprint
        || snapshot(currentAgent, currentCatalog).fingerprint !== job.snapshot.fingerprint) {
        await this.refresh(agentId, false, currentCatalog);
        continue;
      }
      this.activeId = job.id;
      this.controller = new AbortController();
      const controller = this.controller;
      const timer = setTimeout(() => {
        controller.abort();
        try {
          const live = getAdvertisement(agentId);
          if (live?.generation_id === job.id) putAdvertisement({
            ...live, error: "generation_deadline_waiting_for_settlement", updated_at: new Date().toISOString(),
          });
        } catch { console.warn("[advertisements] deadline status could not be recorded"); }
      }, job.policy.timeout_ms);
      try {
        if (!reserveAdvertisementCall(Date.now(), job.policy.max_calls_per_hour)) throw new Error("hourly_call_limit");
        const output = validateAdvertisement(await this.generator(job, controller.signal), job.snapshot.source, job.snapshot.knownTools);
        if (controller.signal.aborted || this.closed) throw new Error("generation_cancelled");
        const latestCatalog = await this.catalog();
        if (controller.signal.aborted || this.closed) throw new Error("generation_cancelled");
        const agent = getAgentConfig(agentId);
        const live = getAdvertisement(agentId);
        if (!agent || !live?.enabled || live.generation_id !== job.id
          || policyFingerprint(getAdvertisementPolicy()) !== job.policyFingerprint
          || snapshot(agent, latestCatalog).fingerprint !== job.snapshot.fingerprint) continue;
        validateAdvertisement(output, job.snapshot.source, latestCatalog.map((tool) => tool.name));
        putAdvertisement({ ...live, status: "ready", advertisement: output, error: null, updated_at: new Date().toISOString() });
      } catch (error) {
        const live = getAdvertisement(agentId);
        if (live?.generation_id === job.id) {
          const known = error instanceof Error && /^(?:output_[a-z_]+|source_size_refused|hourly_call_limit|model_unavailable|provider_unavailable|generation_cancelled)$/.test(error.message);
          putAdvertisement({ ...live, status: "failed", advertisement: null, error: controller.signal.aborted ? "generation_timeout_or_cancelled" : known ? (error as Error).message : "generation_failed", updated_at: new Date().toISOString() });
        }
        console.warn("[advertisements] generation refused or failed");
      } finally { clearTimeout(timer); this.controller = null; this.activeId = null; }
    }
  }
  async settle(): Promise<void> { await this.work; }
  async close(): Promise<void> { this.closed = true; this.queue.clear(); this.controller?.abort(); await this.work; }
}
export function advertisementService(): AdvertisementService {
  return getOrCreateGlobal("__jarela_advertisement_service", () => new AdvertisementService());
}
