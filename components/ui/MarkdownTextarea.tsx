"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  monospace?: boolean;
}

const MD_REMARK_PLUGINS = [remarkGfm];

export function MarkdownTextarea({
  value,
  onChange,
  className = "",
  placeholder,
  rows,
  maxLength,
  monospace,
}: Props) {
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const fontClass = monospace ? "font-mono" : "";
  return (
    <div className="space-y-1">
      {/*
        Toolbar uses span+role=button rather than <button> so the surrounding
        <label> wrapper still implicitly associates with the <textarea> below
        (HTML labels bind to the first labelable descendant, and <button> is
        labelable; spans are not).
      */}
      <div role="toolbar" className="flex items-center justify-end gap-1 text-[10px]">
        <span
          role="button"
          tabIndex={0}
          onClick={() => setMode("edit")}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMode("edit"); } }}
          className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer select-none ${
            mode === "edit" ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg"
          }`}
        >
          Edit
        </span>
        <span
          role="button"
          tabIndex={value.trim() ? 0 : -1}
          aria-disabled={!value.trim()}
          onClick={() => { if (value.trim()) setMode("preview"); }}
          onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && value.trim()) { e.preventDefault(); setMode("preview"); } }}
          className={`px-1.5 py-0.5 rounded transition-colors select-none ${
            !value.trim() ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
          } ${mode === "preview" ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg"}`}
        >
          Preview
        </span>
      </div>
      {mode === "edit" ? (
        <textarea
          className={`${className} ${fontClass}`.trim()}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          maxLength={maxLength}
        />
      ) : (
        <div
          className={`${className} prose prose-invert prose-sm max-w-none jarela-rich overflow-auto`}
          style={{ minHeight: rows ? `${rows * 1.5}em` : undefined }}
        >
          {value.trim() ? (
            <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS}>{value}</ReactMarkdown>
          ) : (
            <span className="text-fg-faint italic">Nothing to preview</span>
          )}
        </div>
      )}
    </div>
  );
}
