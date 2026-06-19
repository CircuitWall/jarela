"use client";

import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

// Exported so wrappers that render their own <textarea> (e.g. MarkdownTextarea)
// can compose the same base class string and stay in sync with TextInput/TextArea.
export const FIELD_CLASS =
  "w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50";

function joinClass(extra?: string) {
  return extra ? `${FIELD_CLASS} ${extra}` : FIELD_CLASS;
}

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} {...rest} className={joinClass(className)} />;
});

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} {...rest} className={joinClass(className)} />;
});
