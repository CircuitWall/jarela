"use client";

import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, Skill } from "@/api/types";
import { errorMessage } from "@/lib/utils/error";

const fieldClass = "w-full rounded border border-border bg-surface-2 p-2 text-xs text-fg";
export function SkillRunner({ skills }: { skills: Skill[] }) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentId, setAgentId] = useState("");
  const [skillId, setSkillId] = useState("memory-organization");
  const [workspace, setWorkspace] = useState("");
  const [input, setInput] = useState("{}");
  const [requestId, setRequestId] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.agents.list().then((items) => {
      if (active) { setAgents(items); setAgentId(items[0]?.id ?? ""); }
    }).catch((failure: unknown) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, []);
  async function send(method: "POST" | "GET" | "DELETE") {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/skill-executions${method === "POST" ? "" : `/${encodeURIComponent(requestId)}`}`, {
        method, cache: "no-store",
        ...(method === "POST" ? { headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent_id: agentId, skill_id: skillId, workspace, input_json: input }) } : {}),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : `Execution request failed (${response.status})`);
      if (method === "POST" && body && typeof body === "object" && "request_id" in body && typeof body.request_id === "string") {
        setRequestId(body.request_id);
      }
      setResult(body);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <details className="rounded border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">Run a checked skill</summary>
    <div className="mt-3 space-y-2">
      <p className="text-xs text-fg-muted">Explicit full-trust execution, not a sandbox. Enable run_skill for the selected agent and use Security settings to choose consent policy. Reading a skill never runs it. Do not enter secrets.</p>
      <label className="block text-xs">Agent
        <select className={fieldClass} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      </label>
      <label className="block text-xs">Skill
        <select className={fieldClass} value={skillId} onChange={(event) => setSkillId(event.target.value)}>
          {skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
        </select>
      </label>
      <label className="block text-xs">Canonical absolute workspace
        <input className={fieldClass} value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
      </label>
      <label className="block text-xs">Exact invocation JSON
        <textarea className={`${fieldClass} min-h-24 font-mono`} value={input} onChange={(event) => setInput(event.target.value)} maxLength={65536} />
      </label>
      <div className="flex flex-wrap gap-2 text-xs">
        <button className="rounded border border-border px-2 py-1" disabled={busy || !agentId || !workspace} onClick={() => void send("POST")}>Request execution</button>
        <button className="rounded border border-border px-2 py-1" disabled={busy || !requestId} onClick={() => void send("GET")}>Refresh result</button>
        <button className="rounded border border-border px-2 py-1" disabled={busy || !requestId} onClick={() => void send("DELETE")}>Cancel execution</button>
      </div>
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      {result !== null && <div role="status" className="text-xs">
        <p>Pending requests require approval in the selected agent&apos;s shared review banner. Pending is not success.</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(result, null, 2)}</pre>
      </div>}
    </div>
  </details>;
}
