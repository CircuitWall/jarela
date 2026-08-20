"use client";

export interface ToolSettingInputProps {
  label: string;
  hint?: string;
  required?: boolean;
  type: "string" | "number" | "boolean" | "enum";
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  enumValues?: readonly string[];
}

export function ToolSettingInput({
  label,
  hint,
  required = false,
  type,
  value,
  onChange,
  placeholder,
  enumValues,
}: ToolSettingInputProps) {
  const labelNode = (
    <span className="text-xs text-fg-subtle">
      {label}
      {required && (
        <span className="text-rose-600 dark:text-rose-400 ml-0.5">*</span>
      )}
    </span>
  );

  const hintNode = hint && (
    <span className="block text-[11px] text-fg-faint">{hint}</span>
  );

  if (type === "boolean") {
    return (
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={value === "true"}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          className="rounded"
        />
        <span>
          {labelNode}
          {hintNode}
        </span>
      </label>
    );
  }

  if (type === "enum") {
    return (
      <label className="block">
        {labelNode}
        {hintNode}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-0.5 w-full px-2 py-1 text-sm bg-surface border border-border rounded font-mono"
        >
          {(enumValues ?? []).map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="block">
      {labelNode}
      {hintNode}
      <input
        type={type === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-0.5 w-full px-2 py-1 text-sm bg-surface border border-border rounded font-mono"
      />
    </label>
  );
}
