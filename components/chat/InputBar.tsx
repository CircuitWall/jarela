"use client";
import { Paperclip, Send, Square, X } from "lucide-react";
import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";
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

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
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
    <div className="border-t border-border bg-surface-2 px-3 sm:px-4 pb-3 pt-2 pb-safe">
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
                <div className="h-10 px-2.5 flex items-center gap-1.5 rounded-lg border border-border bg-surface-3 text-[11px] text-zinc-300 max-w-[140px]">
                  <Paperclip size={11} className="shrink-0 text-zinc-500" />
                  <span className="truncate">{(a as ContentPart & { name: string }).name}</span>
                </div>
              )}
              <button
                onClick={() => removeAttachment(i)}
                className="absolute -top-1.5 -right-1.5 hidden group-hover:flex w-4 h-4 rounded-full bg-zinc-700 text-zinc-200 items-center justify-center"
              >
                <X size={9} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end">
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
          className="shrink-0 p-2.5 rounded-xl text-zinc-500 hover:text-zinc-200 hover:bg-surface-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Attach file or image"
        >
          <Paperclip size={16} />
        </button>

        <textarea
          className="flex-1 resize-none bg-surface-3 text-zinc-100 text-sm rounded-xl px-3 py-2 border border-border focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-zinc-500 max-h-48 min-h-[44px]"
          placeholder={placeholder ?? "Message… or /new to save session to memory"}
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
            className="shrink-0 p-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white transition-colors"
            title="Stop"
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            onClick={onSubmit}
            disabled={(!value.trim() && !attachments.length) || disabled}
            className="shrink-0 p-2.5 rounded-xl bg-accent hover:bg-accent-hover text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Send"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
