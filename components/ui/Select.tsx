import React from "react";

type SelectSize = "sm" | "md";

const SIZE_CLASSES: Record<SelectSize, string> = {
  sm: "text-xs px-2 py-1",
  md: "text-sm px-2 py-1.5",
};

const BASE_CLASSES =
  "rounded border border-border bg-surface-3 text-fg " +
  "focus:outline-none focus:ring-1 focus:ring-accent " +
  "disabled:opacity-50 disabled:cursor-not-allowed " +
  // Force a contrast-safe palette for the OS-rendered <option> menu
  // (Firefox + some Chromium themes inherit the page bg, which lands on
  // surface-2 cards and reads as low-contrast).
  "[&>option]:bg-surface-3 [&>option]:text-fg";

export type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: SelectSize;
  full?: boolean;
};

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ size = "md", full = true, className = "", children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={`${full ? "w-full " : ""}${BASE_CLASSES} ${SIZE_CLASSES[size]} ${className}`.trim()}
        {...rest}
      >
        {children}
      </select>
    );
  },
);
