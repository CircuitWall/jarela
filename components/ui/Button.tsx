"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-accent hover:bg-accent-hover text-white",
  secondary: "border border-border bg-surface-3 hover:bg-surface-2 text-fg",
  ghost: "text-fg-subtle hover:text-fg hover:bg-surface-3",
  danger: "bg-rose-600 hover:bg-rose-700 text-white",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "text-xs px-2 py-1 rounded-md gap-1",
  md: "text-sm px-3 py-1.5 rounded-lg gap-1.5",
  lg: "text-sm font-medium px-4 py-1.5 rounded-xl shadow-sm gap-1.5",
};

const BASE_CLASS =
  "inline-flex items-center justify-center transition-colors " +
  "disabled:opacity-50 disabled:cursor-not-allowed " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", icon, trailingIcon, className, type = "button", children, ...rest },
  ref,
) {
  const composed = `${BASE_CLASS} ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]}${
    className ? ` ${className}` : ""
  }`;
  return (
    <button ref={ref} type={type} className={composed} {...rest}>
      {icon}
      {children}
      {trailingIcon}
    </button>
  );
});
