"use client";
import { Paperclip, Send, Square, X } from "lucide-react";
import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { ContentPart } from "@/api/types";

interface Props {
  value: string;
  onChange: (v: string) => void;
  attachments: ContentPart[];
  onAttachmentsChange: (a: ContentPart[]) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
}

const ACCEPT = "image/*,text/*,.ts,.tsx,.js,.jsx,.json,.md,.py,.go,.rs,.yaml,.yml,.toml,.sh,.sql,.pdf";

// Registry of slash-commands. Keep in sync with handlers in ChatView.tsx.
// To add: append here, then handle the literal in ChatView.handleSubmit.
const SLASH_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "/new", description: "save session to memory and start fresh" },
];

function fileToContentPart(file: File): Promise<ContentPart> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    if (file.type.startsWith("image/") || file.type === "application/pdf") {
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const data = dataUrl.split(",")[1] ?? "";
        if (file.type === "application/pdf") {
          resolve({ type: "file", name: file.name, media_type: "application/pdf", data });
        } else {
          resolve({ type: "image", media_type: file.type, data });
        }
      };
      reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => resolve({ type: "file", name: file.name, media_type: file.type || "text/plain", data: reader.result as string });
      reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
      reader.readAsText(file);
    }
  });
}

export function InputBar({ value, onChange, attachments, onAttachmentsChange, onSubmit, onStop, streaming, disabled, placeholder }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [hlIdx, setHlIdx] = useState(0);

  // Slash-command autocomplete is active only when the entire trimmed input
  // is a `/`-prefixed token (no spaces). That keeps the popover from
  // flashing when the user is mid-sentence and happens to type a slash.
  const suggestions = useMemo(() => {
    const trimmed = value.trimStart();
    if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return [];
    const q = trimmed.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
  }, [value]);
  const showSuggestions = suggestions.length > 0 && !streaming && !disabled;
  const activeIdx = Math.min(hlIdx, Math.max(suggestions.length - 1, 0));

  function applySuggestion(name: string) {
    onChange(`${name} `);
    setHlIdx(0);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (showSuggestions) {
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        // Tab always completes; Enter completes only when the current input
        // is not yet a full command (so `/new<Enter>` still submits).
        const exact = suggestions.find((s) => s.name === value.trim());
        if (!(e.key === "Enter" && exact)) {
          e.preventDefault();
          applySuggestion(suggestions[activeIdx].name);
          return;
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHlIdx((i) => (i + 1) % suggestions.length);
        return;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHlIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      } else if (e.key === "Escape") {
        e.preventDefault();
        onChange("");
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // NOTE: do NOT gate on `streaming` here. ChatView.handleSubmit
      // intentionally queues the message when a run is in flight, and the
      // Send button is hidden during streaming (replaced by Stop). Enter
      // is the ONLY path to push a message into the queue \u2014 if we block
      // it here, queueing is unreachable from the UI.
      if (!disabled && (value.trim() || attachments.length)) onSubmit();
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter((i) => i.kind === "file" && i.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    imageItems.forEach((item) => {
      const file = item.getAsFile();
      if (!file) return;
      fileToContentPart(file)
        .then((part) => onAttachmentsChange([...attachments, part]))
        .catch(console.error);
    });
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    const parts = await Promise.all(files.map(fileToContentPart)).catch((err) => { console.error(err); return []; });
    onAttachmentsChange([...attachments, ...parts]);
    e.target.value = "";
  }

  function removeAttachment(idx: number) {
    onAttachmentsChange(attachments.filter((_, i) => i !== idx));
  }

  return (
    // pb-3 + safe-area inset, additively. `pb-safe` alone overrides `pb-3`
    // and collapses to 0 on devices without a notch (Android Edge, desktop).
    <div
      className="glass border-t border-border/60 px-3 sm:px-4 pt-2"
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
    >
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((a, i) => (
            <div key={i} className="relative group shrink-0">
              {a.type === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`data:${a.media_type};base64,${a.data}`}
                  alt="attachment"
                  className="h-14 w-14 object-cover rounded-lg border border-border"
                />
              ) : (
                <div className="h-10 px-2.5 flex items-center gap-1.5 rounded-lg border border-border bg-surface-3 text-[11px] text-fg-muted max-w-[140px]">
                  <Paperclip size={11} className="shrink-0 text-fg-faint" />
                  <span className="truncate">{(a as ContentPart & { name: string }).name}</span>
                </div>
              )}
              <button
                onClick={() => removeAttachment(i)}
                className="absolute -top-1.5 -right-1.5 hidden group-hover:flex w-4 h-4 rounded-full bg-surface-3 text-fg items-center justify-center"
              >
                <X size={9} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative flex gap-2 items-end">
        {/* Slash-command popover. Anchored to the textarea via the relative
            parent so it floats above the input without affecting layout. */}
        {showSuggestions && (
          <div className="absolute left-[52px] right-[52px] bottom-full mb-1 z-10 max-h-48 overflow-y-auto rounded-xl border border-border/60 bg-surface-2/95 shadow-lg backdrop-blur">
            {suggestions.map((s, i) => (
              <button
                key={s.name}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); applySuggestion(s.name); }}
                onMouseEnter={() => setHlIdx(i)}
                className={`w-full text-left px-3 py-2 flex items-baseline gap-2 text-sm transition-colors ${
                  i === activeIdx ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-3/60"
                }`}
              >
                <span className="font-mono text-accent">{s.name}</span>
                <span className="text-xs text-fg-faint truncate">{s.description}</span>
              </button>
            ))}
            <div className="px-3 py-1 text-[10px] text-fg-faint border-t border-border/40">
              Tab to complete · ↑↓ to navigate · Esc to clear
            </div>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={handleFileChange}
          disabled={disabled}
        />

        {/* Attach button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || streaming}
          className="shrink-0 h-11 w-11 flex items-center justify-center rounded-xl text-fg-faint hover:text-fg hover:bg-surface-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Attach file or image"
        >
          <Paperclip size={16} />
        </button>

        <textarea
          className="flex-1 resize-none bg-surface-3/60 text-fg text-sm rounded-xl px-3 py-2 border border-border/60 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent/40 placeholder:text-fg-faint max-h-48 min-h-[44px] transition-colors"
          placeholder={placeholder ?? "Message…"}
          rows={1}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 192)}px`;
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled}
        />

        {streaming ? (
          <button
            onClick={onStop}
            className="glass-btn-stop shrink-0 h-11 w-11 flex items-center justify-center rounded-xl text-white transition-colors"
            title="Stop"
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            onClick={onSubmit}
            disabled={(!value.trim() && !attachments.length) || disabled}
            className="glass-btn-send shrink-0 h-11 w-11 flex items-center justify-center rounded-xl text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Send"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
