"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { api } from "@/api/client";
import type { AgentConfig } from "@/api/types";
import { AuthoringOperationPreview } from "@/components/proposals/AuthoringOperationPreview";
import { errorMessage } from "@/lib/utils/error";

const fieldClass = "w-full rounded border border-border bg-surface-2 p-2 text-xs text-fg";
const receiptSchema = z.object({ operation_id: z.uuid(), proposal_id: z.uuid() });
export function AuthoringWorkflows() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentId, setAgentId] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [type, setType] = useState<"extension" | "contribution">("extension");
  const [body, setBody] = useState("{}");
  const [result, setResult] = useState<unknown>(null);
  const [pending, setPending] = useState<z.infer<typeof receiptSchema> | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.agents.list().then((items) => { if (active) { setAgents(items); setAgentId(items[0]?.id ?? ""); } })
      .catch((failure: unknown) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, []);
  async function perform(operation: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { setResult(await operation()); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (pending) throw new Error("Decide or cancel the current operation before submitting another");
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request must be a JSON object");
    const response = await fetch(`/api/v1/${type === "extension" ? "extension-authoring" : "contribution-authoring"}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...parsed, agentId, ...("action" in parsed && parsed.action === "create" ? { workspace } : {}) }),
    });
    const output: unknown = await response.json();
    if (!response.ok) throw new Error(output && typeof output === "object" && "error" in output ? String(output.error) : "Authoring request failed");
    const receipt = receiptSchema.safeParse(output);
    if (receipt.success) { setPending(receipt.data); setReviewed(false); }
    return output;
  }
  function example() {
    setBody(JSON.stringify(type === "extension" ? {
      action: "create", input: { name: "fixture_echo", goal: "Read a local synthetic value", discovery: { decision: "author", evidence: "No configured fixture echo tool" } },
    } : { action: "create", input: { destination: "example/fixture", branch: "fix/fixture", base_revision: "REPLACE_WITH_EXACT_BASE_COMMIT",
      classification: "extension", summary: "Describe the selected change", ownership: "user_owned",
      license_review: "Record actual destination rules and rights", commit_message: "fix(fixture): verify synthetic change",
      files: [{ path: "test/fixture.test.cjs", content: "REPLACE_WITH_EXACT_SELECTED_WORKTREE_TEXT" }], test_files: ["test/fixture.test.cjs"] } }, null, 2));
  }
  return <details className="rounded border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">Extension and contribution workflows</summary>
    <div className="mt-3 space-y-2 text-xs">
      <p>Single-stage, exact review only. Loading examples never executes code. Tests/imports have full host access, NOT a sandbox. No automatic installation, publication or rollback. Pending requests expire on restart.</p>
      <label className="block">Authoring agent
        <select className={fieldClass} value={agentId} disabled={busy || !!pending} onChange={(event) => setAgentId(event.target.value)}>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      </label>
      <label className="block">Authoring canonical absolute workspace
        <input className={fieldClass} value={workspace} disabled={busy || !!pending} onChange={(event) => setWorkspace(event.target.value)} />
      </label>
      <label className="block">Authoring workflow type
        <select className={fieldClass} value={type} disabled={busy || !!pending} onChange={(event) => { setType(event.target.value === "extension" ? "extension" : "contribution"); setResult(null); }}>
          <option value="extension">Extension</option><option value="contribution">Contribution</option>
        </select>
      </label>
      <button className="underline" disabled={busy || !!pending} onClick={example}>Load inert authoring example</button>
      <p>After creating an extension session, submit {`{"action":"request","input":{"id":"SESSION_ID","stage":"stage"}}`}, then request test, install, configure (with fixture_origin), enable and verify separately. Disable/remove, restore and discarding inert source are separate stages. Consult the built-in skills for contribution contracts.</p>
      <p>Contribution examples require actual base and selected text, a clean Git workspace and its existing Vitest installation. Create requests tests only. After observed passing tests, use {`{"action":"commit","operation_id":"OPERATION_ID"}`}, then push and draft_pr with the same operation ID; each requests a new independent review.</p>
      <label className="block">Authoring request JSON
        <textarea className={`${fieldClass} min-h-32 font-mono`} maxLength={65536} value={body} disabled={busy || !!pending} onChange={(event) => setBody(event.target.value)} />
      </label>
      <button className="rounded border border-border px-2 py-1" disabled={busy || !!pending || !agentId || body === "{}"} onClick={() => void perform(submit)}>Submit authoring request</button>
      {pending && <section className="space-y-2 rounded border border-border p-2">
        <AuthoringOperationPreview key={pending.operation_id} id={pending.operation_id} type={type} onReviewed={setReviewed} />
        <div className="flex gap-2">
          <button disabled={busy || !reviewed} className="rounded border border-border px-2 py-1" onClick={() => void perform(async () => {
            const outcome = await api.pending.approve(pending.proposal_id);
            setPending(null); setReviewed(false);
            return outcome;
          })}>Approve this authoring stage</button>
          <button disabled={busy} className="rounded border border-border px-2 py-1" onClick={() => void perform(async () => {
            const outcome = await api.pending.deny(pending.proposal_id);
            setPending(null); setReviewed(false); return outcome;
          })}>Deny this authoring stage</button>
          {busy && <button className="rounded border border-border px-2 py-1" onClick={() => {
            void fetch(`/api/v1/authoring-operations/${pending.operation_id}?type=${type}`, { method: "DELETE" })
              .then((response) => { if (!response.ok) throw new Error("Cancellation refused; inspect actual operation"); })
              .catch((failure: unknown) => setError(errorMessage(failure)));
          }}>Cancel active authoring stage</button>}
        </div>
      </section>}
      {error && <p role="alert" className="text-red-500">{error}</p>}
      {result !== null && <pre aria-label="Authoring result" className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(result, null, 2)}</pre>}
    </div>
  </details>;
}
