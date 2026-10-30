"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { errorMessage } from "@/lib/utils/error";

const detailSchema = z.object({
  input_json: z.string(), artifact_revision: z.string(), workspace: z.string(),
  runtime_version: z.string(), timeout_ms: z.number(), max_output_bytes: z.number(),
  expires_at: z.string(),
  definition_json: z.string().optional(),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number(), base64: z.string() })),
});

export function SkillExecutionPreview({ requestId, onReviewed, workflow = false }: {
  requestId: string; onReviewed(value: boolean): void; workflow?: boolean;
}) {
  const [detail, setDetail] = useState<z.infer<typeof detailSchema> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/${workflow ? "workflow-approvals" : "skill-executions"}/${encodeURIComponent(requestId)}`, {
      cache: "no-store", signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Execution request unavailable or expired; request fresh approval");
      setDetail(detailSchema.parse(await response.json()));
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [requestId, workflow]);
  if (error) return <p role="alert">{error}</p>;
  if (!detail) return <p role="status">Loading exact execution request...</p>;
  return <div className="space-y-2">
    <p className="text-amber-500">Full host access: this code is NOT sandboxed. It can access files and the network as the app user. Approval is single-use and expires.</p>
    <p className="break-all font-mono">Artifact: {detail.artifact_revision}</p>
    <p className="break-all">Workspace: {detail.workspace}</p>
    <p>Node {detail.runtime_version}; timeout {detail.timeout_ms} ms; output {detail.max_output_bytes} bytes. Expires {detail.expires_at}.</p>
    <p>Exact invocation:</p>
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{detail.input_json}</pre>
    {detail.definition_json && <details>
      <summary className="cursor-pointer">Exact bounded workflow plan</summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{detail.definition_json}</pre>
    </details>}
    {detail.files.map((file) => <details key={file.path}>
      <summary className="cursor-pointer break-all">{file.path} ({file.bytes} bytes) — {file.sha256}</summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{
        new TextDecoder().decode(Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0)))
      }</pre>
    </details>)}
    <label className="flex items-start gap-2">
      <input type="checkbox" onChange={(event) => onReviewed(event.target.checked)} />
      I reviewed the exact arguments, code, workspace and limits and authorize this full-trust execution.
    </label>
  </div>;
}
