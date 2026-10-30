"use client";

import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, WorkflowRun } from "@/api/types";
import { errorMessage } from "@/lib/utils/error";

const fieldClass = "w-full rounded border border-border bg-surface-2 p-2 text-xs text-fg";
export function WorkflowRunner() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentId, setAgentId] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [definition, setDefinition] = useState("");
  const [invocation, setInvocation] = useState("{}");
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.agents.list().then((items) => {
      if (active) { setAgents(items); setAgentId(items[0]?.id ?? ""); }
    }).catch((failure: unknown) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, []);
  async function perform(operation: () => Promise<WorkflowRun | void>) {
    setBusy(true); setError("");
    try {
      const updated = await operation();
      const listed = await api.workflows.list(agentId);
      setRuns(updated ? listed.map((run) => run.id === updated.id ? updated : run) : listed);
    }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  async function loadTemplate() {
    const response = await fetch("/api/v1/workflow-templates/memory-organization", { cache: "no-store" });
    const body: unknown = await response.json();
    if (!response.ok || !body || typeof body !== "object" || !("definitionText" in body) || typeof body.definitionText !== "string") {
      throw new Error("Memory Organization workflow template unavailable");
    }
    setDefinition(body.definitionText);
    setInvocation(JSON.stringify({ now: new Date().toISOString(), entries: [] }, null, 2));
  }
  return <details className="rounded border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">Durable workflows</summary>
    <div className="mt-3 space-y-2">
      <p className="text-xs text-fg-muted">Definitions and checked results are encrypted locally. Script-plan approvals are separate from typed choice answers. Interrupted writes are never replayed automatically. Do not enter secrets.</p>
      <label className="block text-xs">Workflow agent
        <select className={fieldClass} value={agentId} onChange={(event) => { setAgentId(event.target.value); setRuns([]); }}>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      </label>
      <label className="block text-xs">Workflow canonical absolute workspace
        <input className={fieldClass} value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
      </label>
      <button className="text-xs underline" disabled={busy || !agentId} onClick={() => void perform(loadTemplate)}>Load read-only Memory Organization example</button>
      <label className="block text-xs">Versioned definition JSON
        <textarea className={`${fieldClass} min-h-32 font-mono`} value={definition} onChange={(event) => setDefinition(event.target.value)} maxLength={65536} />
      </label>
      <label className="block text-xs">Workflow invocation JSON
        <textarea className={`${fieldClass} min-h-24 font-mono`} value={invocation} onChange={(event) => setInvocation(event.target.value)} maxLength={65536} />
      </label>
      <div className="flex flex-wrap gap-2 text-xs">
        <button className="rounded border border-border px-2 py-1" disabled={busy || !agentId || !workspace || !definition}
          onClick={() => void perform(() => api.workflows.create({ agentId, workspace, definitionText: definition, invocationJson: invocation }))}>Create workflow</button>
        <button className="rounded border border-border px-2 py-1" disabled={busy || !agentId}
          onClick={() => void perform(async () => {})}>Refresh workflows</button>
      </div>
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      {runs.map((run) => <section key={run.id} className="space-y-2 rounded border border-border p-2 text-xs">
        <p className="break-all font-mono">{run.id} — {run.phase} — version {run.version}</p>
        {run.error && <p role="alert">{run.error}</p>}
        {run.executionApproval && <p>Script-plan approval is pending in the agent&apos;s shared review banner. After approval, resume this workflow.</p>}
        <div className="flex flex-wrap gap-2">
          <button className="rounded border border-border px-2 py-1" disabled={busy || !["ready", "running"].includes(run.phase)}
            onClick={() => void perform(() => api.workflows.mutate(run.id, { action: "advance", agentId, version: run.version }))}>Resume / recover</button>
          <button className="rounded border border-border px-2 py-1" disabled={busy || ["completed", "failed", "cancelled"].includes(run.phase)}
            onClick={() => void perform(() => api.workflows.mutate(run.id, { action: "cancel", agentId, version: run.version }))}>Cancel workflow</button>
          {run.phase === "uncertain" && <button className="rounded border border-border px-2 py-1" disabled={busy}
            onClick={() => void perform(() => api.workflows.mutate(run.id, { action: "reconcile", agentId, version: run.version }))}>Verify through declared read-back</button>}
        </div>
        {run.question && <div className="space-y-2">
          <p>Human response for {run.question.stepId}. This response does NOT authorize script execution.</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(run.question.input, null, 2)}</pre>
          <details><summary>Required response schema</summary><pre className="overflow-auto">{JSON.stringify(run.question.outputSchema, null, 2)}</pre></details>
          <label className="block">Response JSON
            <textarea className={`${fieldClass} font-mono`} value={answer[run.id] ?? "{}"}
              onChange={(event) => setAnswer((prior) => ({ ...prior, [run.id]: event.target.value }))} maxLength={65536} />
          </label>
          <button className="rounded border border-border px-2 py-1" disabled={busy}
            onClick={() => void perform(() => api.workflows.mutate(run.id, { action: "answer", agentId,
              version: run.version, revision: run.revision, stepId: run.question!.stepId, answerJson: answer[run.id] ?? "{}" }))}>Submit typed response</button>
        </div>}
        <details><summary>Checked step results and evidence</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(run.steps, null, 2)}</pre>
        </details>
      </section>)}
    </div>
  </details>;
}
