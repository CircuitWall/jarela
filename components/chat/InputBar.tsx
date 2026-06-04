"use client";
import { Mic, Paperclip, Send, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { ContentPart } from "@/api/types";

interface Props {
  value: string;
  onChange: (v: string) => void;
  attachments: ContentPart[];
  onAttachmentsChange: (a: ContentPart[]) => void;
  // Default Send / Enter. Caller decides idle-send vs steer based on streaming state.
  onSubmit: () => void;
  // Cmd/Ctrl+Enter — explicit "queue this turn" path. Caller queues regardless of streaming.
  onQueue: () => void;
  // Pure interrupt — abort the in-flight run without follow-up.
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
  // Voice push-to-talk — only rendered when the active agent has
  // voice_enabled. Tapping mic records via MediaRecorder; on stop the audio
  // is POSTed to /api/v1/voice/transcribe and the transcript is handed back
  // to the parent (which is responsible for submitting it and arming the
  // auto-speak-on-reply flag).
  voiceEnabled?: boolean;
  agentId?: string | null;
  onVoiceTranscript?: (text: string) => void;
}

const ACCEPT = "image/*,text/*,.ts,.tsx,.js,.jsx,.json,.md,.py,.go,.rs,.yaml,.yml,.toml,.sh,.sql,.pdf";

// Registry of slash-commands. Keep in sync with handlers in ChatView.tsx.
// To add: append here, then handle the literal in ChatView.handleSubmit.
const SLASH_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "/new", description: "save session to memory and start fresh" },
  { name: "/btw", description: "redirect: abort current run and send this instead" },
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

export function InputBar({ value, onChange, attachments, onAttachmentsChange, onSubmit, onQueue, onStop, streaming, disabled, placeholder, voiceEnabled, agentId, onVoiceTranscript }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [hlIdx, setHlIdx] = useState(0);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    return () => {
      const r = recorderRef.current;
      if (r && r.state !== "inactive") {
        try { r.stop(); } catch { /* ignore */ }
      }
      r?.stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function startRecording() {
    if (!voiceEnabled || !agentId || recording || transcribing) return;
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Prefer webm/opus when available — universally supported by Chromium
      // and Firefox. Safari only ships mp4/aac; the empty-string fallback
      // lets the browser pick whatever it can encode.
      const mime =
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
          : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4"
          : "";
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        chunksRef.current = [];
        if (blob.size === 0) { setRecording(false); return; }
        setRecording(false);
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append("agent_id", agentId);
          fd.append("audio", blob, `voice.${(rec.mimeType || "audio/webm").includes("mp4") ? "mp4" : "webm"}`);
          const res = await fetch("/api/v1/voice/transcribe", { method: "POST", body: fd });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
          const { text } = (await res.json()) as { text: string };
          const trimmed = text.trim();
          if (trimmed) onVoiceTranscript?.(trimmed);
        } catch (err) {
          setVoiceError(err instanceof Error ? err.message : String(err));
        } finally {
          setTranscribing(false);
        }
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : String(err));
      setRecording(false);
    }
  }

  function stopRecording() {
    const r = recorderRef.current;
    if (r && r.state !== "inactive") {
      try { r.stop(); } catch { /* ignore */ }
    }
  }

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
      if (!disabled && (value.trim() || attachments.length)) {
        // Cmd/Ctrl+Enter is the explicit "queue" shortcut. Plain Enter goes
        // through onSubmit, which is steer-when-streaming / send-when-idle.
        if (e.metaKey || e.ctrlKey) onQueue();
        else onSubmit();
      }
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

        {voiceEnabled && agentId && (
          <button
            onClick={recording ? stopRecording : startRecording}
            disabled={disabled || streaming || transcribing}
            className={`shrink-0 h-11 w-11 flex items-center justify-center rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              recording
                ? "bg-rose-500 text-white animate-pulse"
                : "text-fg-faint hover:text-fg hover:bg-surface-3"
            }`}
            title={recording ? "Stop recording" : transcribing ? "Transcribing…" : "Record voice message"}
            aria-label={recording ? "Stop recording" : "Record voice message"}
          >
            {recording ? <Square size={14} /> : <Mic size={16} />}
          </button>
        )}

        <textarea
          className="flex-1 resize-none bg-surface-3/60 text-fg text-sm rounded-xl px-3 py-2 border border-border/60 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent/40 placeholder:text-fg-faint max-h-[84px] min-h-[44px] transition-colors"
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

        {streaming && (
          <button
            onClick={onStop}
            className="glass-btn-stop shrink-0 h-11 w-11 flex items-center justify-center rounded-xl text-white transition-colors"
            title="Stop (interrupt without sending)"
            aria-label="Stop"
          >
            <Square size={16} />
          </button>
        )}
        <button
          onClick={onSubmit}
          disabled={(!value.trim() && !attachments.length) || disabled}
          className="glass-btn-send shrink-0 h-11 w-11 flex items-center justify-center rounded-xl text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={streaming
            ? "Steer — abort current and send this instead (⌘/Ctrl+Enter to queue)"
            : "Send (⌘/Ctrl+Enter to queue)"}
          aria-label={streaming ? "Steer" : "Send"}
        >
          <Send size={16} />
        </button>
      </div>
      {voiceError && (
        <p className="mt-1 text-[11px] text-rose-500" role="alert">{voiceError}</p>
      )}
      {transcribing && !voiceError && (
        <p className="mt-1 text-[11px] text-fg-faint" aria-live="polite">Transcribing…</p>
      )}
    </div>
  );
}
