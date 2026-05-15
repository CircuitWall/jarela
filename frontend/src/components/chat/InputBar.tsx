import { Send, Square } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
}

export function InputBar({ value, onChange, onSubmit, onStop, streaming, disabled }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!streaming && !disabled && value.trim()) onSubmit();
    }
  }

  return (
    <div className="border-t border-border bg-surface-2 px-4 py-3">
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none bg-surface-3 text-zinc-100 text-sm rounded-xl px-3 py-2 border border-border focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-zinc-500 max-h-48 min-h-[44px]"
          placeholder="Message… (Enter to send, Shift+Enter for newline)"
          rows={1}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 192)}px`;
          }}
          onKeyDown={handleKeyDown}
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
            disabled={!value.trim() || disabled}
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
