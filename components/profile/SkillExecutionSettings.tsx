"use client";

import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import { SettingsCard } from "@/components/ui/SettingsCard";
import { errorMessage } from "@/lib/utils/error";
import {
  defaultSkillExecutionPolicy, SkillExecutionPolicySchema, SkillRevisionTrustSchema,
  type SkillExecutionPolicy, type SkillRevisionTrust,
} from "@/lib/skills/execution-policy";

const endpoint = "/api/v1/security/skill-execution";
const emptyTrust = (): SkillRevisionTrust => ({
  revision: "", agent_id: "", workspace: "", max_timeout_ms: 60_000, max_output_bytes: 65_536,
});
const inputClass = "w-full rounded-lg border border-border bg-surface-3 px-2 py-1.5 text-sm text-fg";

async function loadPolicy(method: "GET" | "PUT", policy?: SkillExecutionPolicy) {
  const res = await fetch(endpoint, {
    method, cache: "no-store",
    ...(policy ? { headers: { "content-type": "application/json" }, body: JSON.stringify(policy) } : {}),
  });
  if (!res.ok) {
    const body: unknown = await res.json();
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `Security settings request failed (${res.status})`;
    throw new Error(message);
  }
  const body: unknown = await res.json();
  if (!body || typeof body !== "object" || !("policy" in body) || !("safety_mode" in body)
    || !["safe", "mostly_safe", "bypass"].includes(String(body.safety_mode))
    || !("execution_available" in body) || body.execution_available !== false) {
    throw new Error("Invalid skill execution settings response");
  }
  return { policy: SkillExecutionPolicySchema.parse(body.policy), safetyMode: String(body.safety_mode) };
}

export function SkillExecutionSettings() {
  const [policy, setPolicy] = useState<SkillExecutionPolicy>(defaultSkillExecutionPolicy);
  const [trust, setTrust] = useState<SkillRevisionTrust>(emptyTrust);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [safetyMode, setSafetyMode] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadPolicy("GET").then((result) => {
      if (!active) return;
      setPolicy(result.policy);
      setSafetyMode(result.safetyMode);
      setLoaded(true);
    }).catch((err: unknown) => { if (active) setError(errorMessage(err)); });
    return () => { active = false; };
  }, []);

  function changePolicy(next: SkillExecutionPolicy) {
    setPolicy(next);
    setMessage(null);
    setError(null);
    setAcknowledged(false);
  }

  function addTrust() {
    const parsed = SkillRevisionTrustSchema.safeParse(trust);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Invalid trust scope"); return; }
    const next = SkillExecutionPolicySchema.safeParse({ ...policy, trusted_revisions: [...policy.trusted_revisions, parsed.data] });
    if (!next.success) { setError(next.error.issues[0]?.message ?? "Invalid trust policy"); return; }
    changePolicy(next.data);
    setTrust(emptyTrust());
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await loadPolicy("PUT", policy);
      setPolicy(result.policy);
      setSafetyMode(result.safetyMode);
      setAcknowledged(false);
      setMessage("Skill execution policy saved. Script execution is not available yet.");
    } catch (err) {
      setError(errorMessage(err));
    } finally { setSaving(false); }
  }

  return (
    <SettingsCard id="skill-execution" icon={<Shield size={14} />} title="Skill execution"
      description="Choose when full-trust skill scripts require consent. These settings do not enable a runner.">
      <div className="space-y-3">
        <p className="text-xs text-fg-muted">Script execution is not available yet. Workflow approval still requires a verified, bounded plan.</p>
        {safetyMode === "safe" && <p className="text-xs text-amber-500">Safe mode blocks all skill scripts regardless of this policy.</p>}
        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        {message && <p role="status" className="text-xs text-emerald-500">{message}</p>}
        {!loaded && !error && <p className="text-xs text-fg-muted">Loading skill execution policy...</p>}
        <fieldset disabled={!loaded || saving} className="space-y-3 disabled:opacity-50">
          <label className="block text-xs text-fg-muted">
            Consent policy
            <select className={inputClass} value={policy.mode}
              onChange={(event) => {
                const mode = SkillExecutionPolicySchema.shape.mode.parse(event.target.value);
                changePolicy({ ...policy, mode });
              }}>
              <option value="blocked">Blocked</option>
              <option value="ask_each_time">Ask each time</option>
              <option value="approve_workflow">Approve a workflow run</option>
              <option value="trusted_revisions">Trust selected revisions</option>
            </select>
          </label>
          {policy.mode === "approve_workflow" && <p className="text-xs text-fg-muted">
            One approval will cover only the declared workflow steps and bounded repetitions. Missing workflow consent must block execution.
          </p>}
          <p className="text-xs text-amber-500">
            Scripts are not sandboxed: they can access host files and the network as the app&apos;s OS user.
            Revision trust persists across restarts and covers different valid inputs in the exact agent/workspace scope.
            Changed code or limits outside the grant require fresh consent. Revoking trust does not stop running code.
          </p>
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Trusted revisions ({policy.trusted_revisions.length}/64)</h4>
            <p className="text-xs text-fg-muted">Applied only in Trust selected revisions mode. Use the verified snapshot digest, exact agent ID and resolved absolute host workspace path, not a skill name or source-file hash.</p>
            {policy.trusted_revisions.map((grant, index) => (
              <div key={JSON.stringify([grant.revision, grant.agent_id, grant.workspace])} className="rounded-lg border border-border p-2 text-xs">
                <p className="break-all font-mono">{grant.revision}</p>
                <p className="break-all">{grant.agent_id} | {grant.workspace}</p>
                <p>Timeout &lt;= {grant.max_timeout_ms} ms; output &lt;= {grant.max_output_bytes} bytes</p>
                <p>{grant.approval
                  ? `Approved ${grant.approval.approved_at} | Record ${grant.approval.id}`
                  : "Not approved yet. Select Trust selected revisions, acknowledge and save to approve."}</p>
                <button type="button" className="text-red-400" aria-label={`Remove trusted revision ${index + 1}`}
                  onClick={() => changePolicy({ ...policy, trusted_revisions: policy.trusted_revisions.filter((_, i) => i !== index) })}>Remove</button>
              </div>
            ))}
            <label className="block text-xs">Revision (SHA-256)
              <input className={inputClass} value={trust.revision} onChange={(e) => setTrust({ ...trust, revision: e.target.value })} />
            </label>
            <label className="block text-xs">Agent ID
              <input className={inputClass} value={trust.agent_id} onChange={(e) => setTrust({ ...trust, agent_id: e.target.value })} />
            </label>
            <label className="block text-xs">Resolved workspace path
              <input className={inputClass} value={trust.workspace} onChange={(e) => setTrust({ ...trust, workspace: e.target.value })} />
            </label>
            <label className="block text-xs">Maximum timeout (ms)
              <input type="number" min={1000} max={120000} step={1} className={inputClass} value={trust.max_timeout_ms}
                onChange={(e) => setTrust({ ...trust, max_timeout_ms: Number(e.target.value) })} />
            </label>
            <label className="block text-xs">Maximum output (bytes)
              <input type="number" min={1} max={262144} step={1} className={inputClass} value={trust.max_output_bytes}
                onChange={(e) => setTrust({ ...trust, max_output_bytes: Number(e.target.value) })} />
            </label>
            <button type="button" onClick={addTrust} className="rounded-lg border border-border px-3 py-1.5 text-xs">Add trust scope to draft</button>
          </div>
          {policy.mode === "trusted_revisions" && policy.trusted_revisions.length > 0 && (
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              I trust these exact revisions to run without repeated prompts, with different valid inputs in the listed scopes.
            </label>
          )}
          <button type="button" onClick={save}
            disabled={policy.mode === "trusted_revisions" && policy.trusted_revisions.length > 0 && !acknowledged}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs text-bg disabled:opacity-50">
            {saving ? "Saving..." : "Save skill execution policy"}
          </button>
        </fieldset>
      </div>
    </SettingsCard>
  );
}
