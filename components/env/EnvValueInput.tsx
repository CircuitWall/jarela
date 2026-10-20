"use client";

import type { KeyboardEventHandler } from "react";
import type { EnvVarType } from "@/lib/env/schema";

export const ENV_TYPE_LABEL: Record<EnvVarType, string> = {
  int: "integer",
  string: "text",
  bool: "boolean",
  enum: "choice",
};

interface EnvValueInputProps {
  type: EnvVarType;
  value: string;
  onChange: (value: string) => void;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  inputRef?: (element: HTMLInputElement | HTMLSelectElement | null) => void;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement | HTMLSelectElement>;
  autoFocus?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function EnvValueInput({
  type,
  value,
  onChange,
  enumValues,
  min,
  max,
  inputRef,
  onKeyDown,
  autoFocus,
  ariaLabel,
  className = "px-2 py-1 rounded border border-border bg-surface text-fg text-[11px] font-mono",
}: EnvValueInputProps) {
  if (type === "bool" || type === "enum") {
    const choices = type === "bool" ? ["true", "false"] : enumValues ?? [];
    const selectedValue = type === "bool" ? normalizeBoolean(value) : value;
    const currentIsAllowed = choices.includes(selectedValue);
    return (
      <select
        ref={inputRef}
        value={selectedValue}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        className={className}
      >
        {!currentIsAllowed && selectedValue !== "" && (
          <option value={selectedValue} disabled>Invalid current value: {selectedValue}</option>
        )}
        {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
      </select>
    );
  }

  return (
    <input
      ref={inputRef}
      type={type === "int" ? "number" : "text"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      min={type === "int" ? min : undefined}
      max={type === "int" ? max : undefined}
      step={type === "int" ? 1 : undefined}
      className={className}
    />
  );
}

function normalizeBoolean(value: string): string {
  if (/^(1|true)$/i.test(value.trim())) return "true";
  if (/^(0|false)$/i.test(value.trim())) return "false";
  return value;
}