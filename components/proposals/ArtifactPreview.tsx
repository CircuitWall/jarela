"use client";

export function ArtifactPreview({ payload }: { payload: Record<string, unknown> }) {
  return (
    <details className="my-2 text-fg">
      <summary className="cursor-pointer">Review full before/after text</summary>
      <p className="my-1 font-mono">{String(payload.id)}</p>
      {(["expected_content", "content"] as const).map((field) => (
        <label key={field} className="block my-2">
          {field === "expected_content" ? "Before" : "After"}
          <textarea
            readOnly
            value={typeof payload[field] === "string" ? payload[field] : "(not set)"}
            className="mt-1 h-40 w-full rounded border border-border bg-surface-2 p-2 font-mono text-fg"
          />
        </label>
      ))}
    </details>
  );
}
