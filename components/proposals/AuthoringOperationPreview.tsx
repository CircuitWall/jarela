"use client";

import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/utils/error";

export function AuthoringOperationPreview({ id, type, onReviewed }: {
  id: string; type: "extension" | "contribution"; onReviewed(value: boolean): void;
}) {
  const [detail, setDetail] = useState<unknown>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setError(""); onReviewed(false);
    fetch(`/api/v1/authoring-operations/${encodeURIComponent(id)}?type=${type}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Review expired or unavailable; request a fresh operation");
        setDetail(await response.json());
      }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
    // The parent callback only records review state; its identity changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, type]);
  if (error) return <p role="alert">{error}</p>;
  if (!detail) return <p role="status">Loading exact authoring operation...</p>;
  return <div className="space-y-2">
    <p className="text-amber-500">Approve this stage only. Tests and imports have full host access, NOT a sandbox. Local execution never grants installation or publication rights. Changes invalidate review.</p>
    <pre aria-label="Exact authoring operation" className="max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(detail, null, 2)}</pre>
    <label className="flex items-start gap-2">
      <input type="checkbox" onChange={(event) => onReviewed(event.target.checked)} />
      I reviewed the exact source/diff, destination, evidence and effects and authorize only this operation.
    </label>
  </div>;
}
