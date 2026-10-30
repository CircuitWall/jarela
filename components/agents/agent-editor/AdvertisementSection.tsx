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
type Policy = z.infer<typeof policySchema>;
type Snapshot = z.infer<typeof snapshotSchema>;
type Operation = "refresh" | "save" | "regenerate" | "disable" | "enable";
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

export function AdvertisementSection({ agentId, models }: { agentId?: string; models: ModelConfig[] }) {
  return (
    <Section title="Agent advertisement">
      <p className="text-xs text-fg-subtle">
        Optional generation is disabled by default. It sends this agent&apos;s committed identity and instructions,
        plus bounded permitted tool descriptions, to your explicitly selected model. This may incur provider costs
        and data egress. Conversations and credentials are not included.
      </p>
      <p className="text-xs text-fg-subtle">
        Advertisements are model-generated claims, not proof of capabilities or safety. They grant no permissions.
        Unsaved agent editor changes are never sent. Controls require an unlocked, local loopback session.
      </p>
      {agentId
        ? <AdvertisementControls key={agentId} agentId={agentId} models={models} />
        : <p className="text-xs text-fg-muted">Save this agent first to manage its advertisement.</p>}
    </Section>
  );
}

function AdvertisementControls({ agentId, models }: { agentId: string; models: ModelConfig[] }) {
  const {
    error,
    message,
    busy,
    snapshot,
    policy,
    setDraft,
    setMessage,
    selectedModelAvailable,
    enabledModels,
    policyError,
    dirty,
    run,
    savedModelAvailable,
    advertisement,
    metadata,
  } = useAdvertisementPolicy({ agentId, models });

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {message && <p role="status" className="text-xs text-fg-muted">{message}</p>}
      {busy && <p role="status" className="text-xs text-fg-muted">
        {busy === "refresh" ? "Loading advertisement status..." : busy === "save" ? "Saving generation settings..." : `Requesting ${busy}...`}
      </p>}
      <p className="text-xs text-fg-muted">
        Global generation settings apply to all agents. Saving enabled settings or enabling an advertisement
        may queue generation using committed agent data.
      </p>
      <fieldset disabled={!snapshot || busy !== null} className="space-y-3 disabled:opacity-50">
        <legend className="sr-only">Global advertisement generation settings</legend>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input type="checkbox" checked={policy.enabled}
            onChange={(event) => { setDraft({ ...policy, enabled: event.target.checked }); setMessage(null); }} />
          Enable advertisement generation globally
        </label>
        <label className="block text-xs text-fg-muted">
          Generation model (explicit named selection)
          <select className={inputClass} value={selectedModelAvailable ? policy.model_config_name! : ""}
            onChange={(event) => { setDraft({ ...policy, model_config_name: event.target.value || null }); setMessage(null); }}>
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
                  setDraft({ ...policy, [key]: event.target.valueAsNumber });
                  setMessage(null);
                }} />
              <span className="text-fg-faint">{min}–{max}</span>
            </label>
          ))}
        </div>
        {policyError && <p className="text-xs text-amber-500">{policyError}</p>}
        <button type="button" className={buttonClass} disabled={!!policyError || !dirty}
          onClick={() => { void run("save", policy); }}>Save generation settings</button>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy !== null}
          onClick={() => { void run("refresh"); }}>Refresh advertisement</button>
        <button type="button" className={buttonClass}
          disabled={!snapshot || busy !== null || dirty || !snapshot.policy.enabled || !savedModelAvailable || advertisement?.enabled === false || advertisement?.status === "pending"}
          onClick={() => { void run("regenerate"); }}>Regenerate advertisement</button>
        <button type="button" className={buttonClass} disabled={!snapshot || busy !== null || advertisement?.enabled === false}
          onClick={() => { void run("disable"); }}>Disable advertisement</button>
        <button type="button" className={buttonClass} disabled={!snapshot || busy !== null || advertisement?.enabled !== false}
          onClick={() => { void run("enable"); }}>Enable advertisement</button>
      </div>
      {dirty && <p className="text-xs text-amber-500">Save generation settings before regenerating. Refresh preserves unsaved generation settings.</p>}
      {snapshot && !snapshot.policy.enabled && <p className="text-xs text-fg-muted">Global generation is disabled.</p>}
      {snapshot && !advertisement && <p className="text-xs text-fg-muted">No advertisement generated for this agent.</p>}
      {advertisement && (
        <div className="space-y-2 rounded-lg border border-border p-3 text-xs text-fg-muted">
          <p aria-live="polite">Status: {advertisement.status}</p>
          <p>Per-agent advertisement: {advertisement.enabled ? "enabled" : "disabled"}</p>
          <p>Updated: <time dateTime={advertisement.updated_at}>{advertisement.updated_at}</time></p>
          {advertisement.status === "pending" && <p>Generation pending. Status refreshes automatically.</p>}
          {advertisement.status === "stale" && <p>Stale: committed source or generation settings changed. Regenerate to refresh these claims.</p>}
          {advertisement.status === "ready" && <p>Ready means generated, not verified.</p>}
          {advertisement.error && <p role="alert" className="text-red-400">Generation error: {advertisement.error}</p>}
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

function useAdvertisementPolicy({ agentId, models }: { agentId: string; models: ModelConfig[] }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [busy, setBusy] = useState<Operation | null>("refresh");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const enabledModels = models.filter(isModelEnabled);
  const policy = draft ?? defaults;
  const selectedModelAvailable = enabledModels.some((model) => model.name === policy.model_config_name);
  const dirty = snapshot !== null && JSON.stringify(policy) !== JSON.stringify(snapshot.policy);
  const invalidLimit = limits.find(({ key, min, max }) => !Number.isInteger(policy[key]) || policy[key] < min || policy[key] > max);
  const policyError = invalidLimit
    ? `${invalidLimit.label} must be a whole number from ${invalidLimit.min} to ${invalidLimit.max}.`
    : ((policy.enabled || policy.model_config_name !== null) && !selectedModelAvailable)
      ? "Choose an enabled configured model by name; there is no automatic fallback."
      : null;

  const run = useCallback(async (operation: Operation, nextPolicy?: Policy) => {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setBusy(operation);
    setError(null);
    setMessage(null);
    try {
      if (operation === "save") {
        const result = await requestJson(endpoint, current.signal, { policy: nextPolicy }, "PUT");
        const saved = z.object({ policy: policySchema }).parse(result).policy;
        if (current.signal.aborted) return;
        setDraft(saved);
        setMessage("Generation settings saved.");
      }
      const result = operation === "refresh" || operation === "save"
        ? await requestJson(`${endpoint}?agent_id=${encodeURIComponent(agentId)}`, current.signal)
        : await requestJson(endpoint, current.signal, { agent_id: agentId, action: operation }, "POST");
      const parsed = snapshotSchema.safeParse(result);
      if (!parsed.success || (parsed.data.advertisement && parsed.data.advertisement.agent_id !== agentId)) {
        throw new Error("Invalid advertisement response. Refresh to try again.");
      }
      if (current.signal.aborted) return;
      setSnapshot(parsed.data);
      setDraft((previous) => previous ?? parsed.data.policy);
      if (operation !== "refresh" && operation !== "save") {
        setMessage(operation === "regenerate" ? "Regeneration requested." : `Advertisement ${operation}d.`);
      }
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

  const advertisement = snapshot?.advertisement;
  const metadata = advertisement?.advertisement;
  const savedModelAvailable = enabledModels.some((model) => model.name === snapshot?.policy.model_config_name);

  return {
    error,
    message,
    busy,
    snapshot,
    policy,
    setDraft,
    setMessage,
    selectedModelAvailable,
    enabledModels,
    policyError,
    dirty,
    run,
    savedModelAvailable,
    advertisement,
    metadata,
  };
}
