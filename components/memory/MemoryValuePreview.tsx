"use client";

// Memory values are arbitrary JSON. The list rendering used to flatten
// them with a single `JSON.stringify(item.value)`, which is unreadable
// once values contain more than a few fields. This component renders a
// compact preview; clicking the row opens the full JSON editor. It also
// masks values whose key name strongly suggests a secret so a glance at
// the panel doesn't leak tokens to anyone peering at the screen.

const SECRET_KEY_PATTERN =
  /(^|_)(token|secret|password|passwd|api_?key|client_secret|refresh_token|access_token|private_?key|auth)($|_)/i;
const SECRET_MASK = "********";
const MAX_INLINE_FIELDS = 4;
const MAX_INLINE_STRING = 80;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Format a leaf value for inline display. Strings stay unquoted so
 *  short notes read naturally; everything else falls back to JSON. */
function formatLeaf(v: unknown, key?: string): string {
  if (key && typeof v === "string" && isSecretKey(key)) return SECRET_MASK;
  if (v === null) return "null";
  if (typeof v === "string") return truncate(v, MAX_INLINE_STRING);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `${v.length} item${v.length === 1 ? "" : "s"}`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (keys.length === 0) return "{}";
    return `${keys.length} field${keys.length === 1 ? "" : "s"}`;
  }
  return truncate(JSON.stringify(v), MAX_INLINE_STRING);
}

export function MemoryValuePreview({ value }: { value: unknown }) {
  // ── String / primitive / null ──────────────────────────────────────
  if (value === null) {
    return <p className="text-xs text-fg-subtle italic">null</p>;
  }
  if (typeof value === "string") {
    // Multi-line strings deserve a real <pre>; one-liners stay inline.
    if (value.includes("\n")) {
      return (
        <pre className="text-xs text-fg-subtle whitespace-pre-wrap font-mono leading-snug max-h-32 overflow-y-auto">
          {value}
        </pre>
      );
    }
    return <p className="text-xs text-fg-subtle truncate">{value}</p>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <p className="text-xs text-fg-subtle font-mono">{String(value)}</p>;
  }

  // ── Array ───────────────────────────────────────────────────────────
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <p className="text-xs text-fg-faint italic">empty list</p>;
    }
    const preview = value.slice(0, MAX_INLINE_FIELDS).map((v) => formatLeaf(v));
    return (
      <p className="text-xs text-fg-subtle truncate">
        <span className="text-fg-faint">[{value.length}]</span>{" "}
        {preview.join(", ")}
        {value.length > MAX_INLINE_FIELDS && (
          <span className="text-fg-faint"> · +{value.length - MAX_INLINE_FIELDS} more</span>
        )}
      </p>
    );
  }

  // ── Object ──────────────────────────────────────────────────────────
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    if (entries.length === 0) {
      return <p className="text-xs text-fg-faint italic">empty object</p>;
    }
    const summary = record.summary;
    const content = record.content;
    const readableSummary = typeof summary === "string" && summary.trim()
      ? summary
      : typeof content === "string" && content.trim()
        ? content
        : null;
    if (readableSummary) {
      return (
        <p className="text-xs text-fg-subtle whitespace-pre-wrap break-words line-clamp-2" title={readableSummary}>
          {readableSummary}
        </p>
      );
    }
    const head = entries.slice(0, MAX_INLINE_FIELDS);
    const extra = entries.length - head.length;
    return (
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
        {head.map(([k, v]) => (
          <span key={k} className="text-fg-subtle truncate max-w-full">
            <span className="text-fg-faint">{k}:</span>{" "}
            <span className="font-mono">{formatLeaf(v, k)}</span>
          </span>
        ))}
        {extra > 0 && (
          <span className="text-fg-faint">+{extra} more</span>
        )}
      </div>
    );
  }

  // Fallback — shouldn't happen for JSON-decoded input, but keep the
  // component total so callers never have to special-case undefined.
  return <p className="text-xs text-fg-subtle truncate">{String(value)}</p>;
}
