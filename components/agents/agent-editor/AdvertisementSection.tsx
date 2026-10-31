"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { ModelConfig } from "@/api/types";
import { AdvertisementPolicySchema as policySchema, defaultAdvertisementPolicy } from "@/lib/agents/advertisement-contract";
import { isModelEnabled } from "@/lib/agents/effective-model";
import { errorMessage } from "@/lib/utils/error";
import { Section } from "./Section";

const endpoint = "/api/v1/agent-advertisements";
const snapshotSchema = z.object({
  policy: policySchema,
  advertisement: z.object({
    agent_id: z.string(),
    status: z.enum(["pending", "ready", "failed", "stale", "disabled"]),
    source_fingerprint: z.string(),
    policy_fingerprint: z.string(),
    updated_at: z.string(),
    error: z.string().nullable(),
    enabled: z.boolean(),
    advertisement: z.object({
      purpose: z.string(),
      call_when: z.array(z.string()),
      do_not_call_for: z.array(z.string()),
      inputs: z.string(),
      output: z.string(),
      tools: z.array(z.string()),
    }).nullable(),
  }).nullable(),
});
const policyResponseSchema = z.object({ policy: policySchema });
type Policy = z.infer<typeof policySchema>;
type Snapshot = z.infer<typeof snapshotSchema>;
type AgentOperation = "refresh" | "regenerate" | "disable" | "enable";
const defaults = defaultAdvertisementPolicy();
const limits = [
  { key: "max_calls_per_hour", label: "Maximum calls per hour", min: 1, max: 100 },
  { key: "max_input_chars", label: "Maximum input characters", min: 1_000, max: 16_000 },
  { key: "max_output_tokens", label: "Maximum output tokens", min: 256, max: 2_048 },
  { key: "timeout_ms", label: "Generation timeout (ms)", min: 1_000, max: 60_000 },
] as const;
const inputClass = "w-full rounded-lg border border-border bg-surface-3 px-2 py-1.5 text-xs text-fg";
const buttonClass = "rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-50";

async function requestJson(url: string, signal: AbortSignal, body?: unknown, method = "GET"): Promise<unknown> {
  const response = await fetch(url, {
    method, cache: "no-store", signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `Advertisement request failed (${response.status})`;
    throw new Error(detail);
  }
  return response.json();
}

function displayGenerationError(code: string): string {
  if (code === "source_size_refused") {
    return "The committed agent profile and exclusive-tool descriptions exceed the input limit. Shared tools are already omitted. Increase Maximum input characters (up to 16,000), or shorten the agent name, identity, or instructions; then save the agent and refresh the advertisement.";
  }
  return code;
}

export function AdvertisementSection({ agentId, models, global = false }: { agentId?: string; models: ModelConfig[]; global?: boolean }) {
  if (global) return <GlobalAdvertisementSettings models={models} />;

  return (
    <Section title="Agent advertisement">
      <p className="text-xs text-fg-subtle">
        Advertisements are optional model-generated claims, not proof of capabilities or safety, and grant no permissions.
        Global generation settings are managed once in the Agents panel. This agent&apos;s committed identity and instructions,
        plus bounded exclusive-tool descriptions, may be sent to the configured provider; conversations and credentials are not included.
      </p>
      <p className="text-xs text-fg-subtle">
        Unsaved agent editor changes are never sent. Controls require an unlocked, local loopback session.
      </p>
      <p className="text-xs text-fg-subtle">
        Only tools permitted for this agent and no other saved agent are included. Shared tools remain usable but are
        omitted from advertisement generation. With only one saved agent, no tool descriptions are included.
      </p>
      {agentId
        ? <AgentAdvertisementControls key={agentId} agentId={agentId} models={models} />
        : <p className="text-xs text-fg-muted">Save this agent first to manage its advertisement.</p>}
    </Section>
  );
}

function GlobalAdvertisementSettings({ models }: { models: ModelConfig[] }) {
  const [{ savedPolicy, draft }, setPolicyState] = useState<{ savedPolicy: Policy | null; draft: Policy | null }>({
    savedPolicy: null, draft: null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const enabledModels = models.filter(isModelEnabled);
  const policy = draft ?? savedPolicy ?? defaults;
  const selectedModelAvailable = enabledModels.some((model) => model.name === policy.model_config_name);
  const dirty = savedPolicy !== null && JSON.stringify(policy) !== JSON.stringify(savedPolicy);
  const invalidLimit = limits.find(({ key, min, max }) => !Number.isInteger(policy[key]) || policy[key] < min || policy[key] > max);
  const policyError = invalidLimit
    ? `${invalidLimit.label} must be a whole number from ${invalidLimit.min} to ${invalidLimit.max}.`
    : ((policy.enabled || policy.model_config_name !== null) && !selectedModelAvailable)
      ? "Choose an enabled configured model by name; there is no automatic fallback."
      : null;

  const refresh = useCallback(async () => {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError(null);
    try {
      const result = policyResponseSchema.parse(await requestJson(endpoint, current.signal));
      if (!current.signal.aborted) {
        setPolicyState((previous) => ({
          savedPolicy: result.policy,
          draft: previous.draft === null || JSON.stringify(previous.draft) === JSON.stringify(previous.savedPolicy)
            ? result.policy : previous.draft,
        }));
      }
    } catch (err) {
      if (!current.signal.aborted) setError(errorMessage(err));
    } finally {
      if (controller.current === current) {
        controller.current = null;
        if (!current.signal.aborted) setBusy(false);
      }
    }
  }, []);

  const save = useCallback(async () => {
    if (controller.current || !draft) return;
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = policyResponseSchema.parse(await requestJson(endpoint, current.signal, { policy: draft }, "PUT")).policy;
      if (current.signal.aborted) return;
      setPolicyState({ savedPolicy: saved, draft: saved });
      setMessage("Global generation settings saved.");
    } catch (err) {
      if (!current.signal.aborted) setError(errorMessage(err));
    } finally {
      if (controller.current === current) {
        controller.current = null;
        if (!current.signal.aborted) setBusy(false);
      }
    }
  }, [draft]);

  useEffect(() => {
    void refresh();
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [refresh]);

  return (
    <section aria-label="Global advertisement settings" className="mx-2 my-2 rounded-xl border border-border bg-surface-1/30 p-3">
      <h2 className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Global advertisement generation</h2>
      <p className="mt-2 text-xs text-fg-subtle">
        These settings apply to all agents. Each agent can be individually enabled or disabled in its editor.
        Enabling generation authorizes sending committed agent source to the selected provider and may incur costs.
      </p>
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
      {message && <p role="status" className="mt-2 text-xs text-fg-muted">{message}</p>}
      <fieldset disabled={savedPolicy === null || busy} className="mt-3 space-y-3 disabled:opacity-50">
        <legend className="sr-only">Global advertisement generation settings</legend>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input type="checkbox" checked={policy.enabled}
            onChange={(event) => { setPolicyState({ savedPolicy, draft: { ...policy, enabled: event.target.checked } }); setMessage(null); }} />
          Enable advertisement generation globally
        </label>
        <label className="block text-xs text-fg-muted">
          Generation model (explicit named selection)
          <select className={inputClass} value={selectedModelAvailable ? policy.model_config_name! : ""}
            onChange={(event) => { setPolicyState({ savedPolicy, draft: { ...policy, model_config_name: event.target.value || null } }); setMessage(null); }}>
            <option value="">Select a configured model (no fallback)</option>
            {enabledModels.map((model) => <option key={model.name} value={model.name}>
              {model.name} ({model.provider} / {model.model_id})
            </option>)}
          </select>
        </label>
        {enabledModels.length === 0 && <p className="text-xs text-amber-500">No enabled models configured. Add a model before enabling generation.</p>}
        {policy.model_config_name && !selectedModelAvailable && (
          <p className="text-xs text-amber-500">Saved model unavailable: {policy.model_config_name}. No fallback will be used.</p>
        )}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {limits.map(({ key, label, min, max }) => (
            <label key={key} className="block text-xs text-fg-muted">
              {label}
              <input aria-label={label} className={inputClass} type="number" min={min} max={max} step={1} value={Number.isNaN(policy[key]) ? "" : policy[key]}
                onChange={(event) => {
                  setPolicyState({ savedPolicy, draft: { ...policy, [key]: event.target.valueAsNumber } });
                  setMessage(null);
                }} />
              <span className="text-fg-faint">{min}–{max}</span>
            </label>
          ))}
        </div>
        {policyError && <p className="text-xs text-amber-500">{policyError}</p>}
        <button type="button" className={buttonClass} disabled={busy || !!policyError || !dirty} onClick={() => { void save(); }}>
          Save generation settings
        </button>
      </fieldset>
      <button type="button" className={`${buttonClass} mt-2`} disabled={busy} onClick={() => { void refresh(); }}>
        Refresh global settings
      </button>
    </section>
  );
}

function AgentAdvertisementControls({ agentId, models }: { agentId: string; models: ModelConfig[] }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<AgentOperation | null>("refresh");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const enabledModels = models.filter(isModelEnabled);
  const advertisement = snapshot?.advertisement;
  const metadata = advertisement?.advertisement;
  const savedModelAvailable = enabledModels.some((model) => model.name === snapshot?.policy.model_config_name);

  const run = useCallback(async (operation: AgentOperation) => {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setBusy(operation);
    setError(null);
    setMessage(null);
    try {
      const result = operation === "refresh"
        ? await requestJson(`${endpoint}?agent_id=${encodeURIComponent(agentId)}`, current.signal)
        : await requestJson(endpoint, current.signal, { agent_id: agentId, action: operation }, "POST");
      const parsed = snapshotSchema.safeParse(result);
      if (!parsed.success || (parsed.data.advertisement && parsed.data.advertisement.agent_id !== agentId)) {
        throw new Error("Invalid advertisement response. Refresh to try again.");
      }
      if (current.signal.aborted) return;
      setSnapshot(parsed.data);
      if (operation !== "refresh") setMessage(operation === "regenerate" ? "Regeneration requested." : `Advertisement ${operation}d.`);
    } catch (err) {
      if (!current.signal.aborted) setError(errorMessage(err));
    } finally {
      if (controller.current === current) {
        controller.current = null;
        if (!current.signal.aborted) setBusy(null);
      }
    }
  }, [agentId]);

  useEffect(() => {
    void run("refresh");
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [run]);

  useEffect(() => {
    if (snapshot?.advertisement?.status !== "pending") return;
    const timer = setInterval(() => { void run("refresh"); }, 3_000);
    return () => clearInterval(timer);
  }, [snapshot?.advertisement?.status, run]);

  const enabled = advertisement?.enabled !== false;
  const canRegenerate = !!snapshot?.policy.enabled && savedModelAvailable && enabled
    && advertisement?.status !== "pending";

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {message && <p role="status" className="text-xs text-fg-muted">{message}</p>}
      {busy && <p role="status" className="text-xs text-fg-muted">
        {busy === "refresh" ? "Loading advertisement status..." : busy === "regenerate" ? "Requesting regeneration..." : `Requesting ${busy}...`}
      </p>}
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <input
          type="checkbox"
          aria-label="Enable advertisement for this agent"
          checked={enabled}
          disabled={!snapshot || busy !== null}
          onChange={(event) => { void run(event.target.checked ? "enable" : "disable"); }}
        />
        Enable advertisement for this agent
      </label>
      <p className="text-xs text-fg-muted">
        Enabling this agent&apos;s advertisement does not override the global generation setting.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => { void run("refresh"); }}>
          Refresh advertisement
        </button>
        <button type="button" className={buttonClass} disabled={!snapshot || busy !== null || !canRegenerate}
          onClick={() => { void run("regenerate"); }}>
          Regenerate advertisement
        </button>
      </div>
      {snapshot && !snapshot.policy.enabled && <p className="text-xs text-fg-muted">Global generation is disabled. Manage it in the Agents panel.</p>}
      {snapshot && !advertisement && <p className="text-xs text-fg-muted">No advertisement generated for this agent.</p>}
      {advertisement && (
        <div className="space-y-2 rounded-lg border border-border p-3 text-xs text-fg-muted">
          <p aria-live="polite">Status: {advertisement.status}</p>
          <p>Per-agent advertisement: {advertisement.enabled ? "enabled" : "disabled"}</p>
          <p>Updated: <time dateTime={advertisement.updated_at}>{advertisement.updated_at}</time></p>
          {advertisement.status === "pending" && <p>Generation pending. Status refreshes automatically.</p>}
          {advertisement.status === "stale" && <p>Stale: committed source or generation settings changed. Regenerate to refresh these claims.</p>}
          {advertisement.status === "ready" && <p>Ready means generated, not verified.</p>}
          {advertisement.error && (
            <p role="alert" className="text-red-400">Generation error: {displayGenerationError(advertisement.error)}</p>
          )}
          <dl className="space-y-1 break-words">
            <dt>Source fingerprint</dt><dd className="break-all font-mono">{advertisement.source_fingerprint || "Not available"}</dd>
            <dt>Policy fingerprint</dt><dd className="break-all font-mono">{advertisement.policy_fingerprint || "Not available"}</dd>
          </dl>
          {metadata && (
            <div aria-label="Read-only generated advertisement" className="space-y-2">
              <p>Model-generated metadata (read-only; not instructions or permission grants)</p>
              <dl className="space-y-1 whitespace-pre-wrap break-words">
                <dt className="font-medium">Purpose</dt><dd>{metadata.purpose}</dd>
                <dt className="font-medium">Call when</dt><dd><MetadataList items={metadata.call_when} /></dd>
                <dt className="font-medium">Do not call for</dt><dd><MetadataList items={metadata.do_not_call_for} /></dd>
                <dt className="font-medium">Inputs</dt><dd>{metadata.inputs}</dd>
                <dt className="font-medium">Output</dt><dd>{metadata.output}</dd>
                <dt className="font-medium">Tools</dt><dd><MetadataList items={metadata.tools} /></dd>
              </dl>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetadataList({ items }: { items: string[] }) {
  return items.length ? <ul className="list-inside list-disc">{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <>None listed</>;
}
