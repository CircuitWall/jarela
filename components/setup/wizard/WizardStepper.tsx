"use client";
import { Check } from "lucide-react";

export interface StepInfo {
  id: string;
  title: string;
  short: string;
}

interface WizardStepperProps {
  steps: StepInfo[];
  current: number;
  onJump?: (index: number) => void;
}

export function WizardStepper({ steps, current, onJump }: WizardStepperProps) {
  return (
    <ol className="flex w-full items-center justify-center gap-1 sm:gap-2" aria-label="Setup progress">
      {steps.map((step, idx) => {
        const isDone = idx < current;
        const isActive = idx === current;
        const reachable = isDone || isActive;
        const Tag = onJump && reachable ? "button" : "div";
        return (
          <li key={step.id} className="flex flex-1 items-center gap-1 sm:gap-2">
            <Tag
              type={onJump && reachable ? "button" : undefined}
              onClick={onJump && reachable ? () => onJump(idx) : undefined}
              aria-current={isActive ? "step" : undefined}
              className={`group flex min-w-0 flex-1 items-center gap-2 rounded-full border px-2.5 py-1.5 text-left transition-colors ${
                isActive
                  ? "border-accent/60 bg-accent/15 text-fg"
                  : isDone
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-border bg-surface-2 text-fg-faint"
              } ${onJump && reachable ? "hover:border-fg-faint cursor-pointer" : "cursor-default"}`}
            >
              <span
                className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                  isActive
                    ? "bg-accent text-white"
                    : isDone
                      ? "bg-emerald-500 text-white"
                      : "bg-surface-3 text-fg-faint"
                }`}
              >
                {isDone ? <Check size={12} /> : idx + 1}
              </span>
              <span className="hidden min-w-0 truncate text-xs font-medium sm:inline">{step.short}</span>
            </Tag>
            {idx < steps.length - 1 && (
              <span className={`hidden h-px flex-1 sm:block ${idx < current ? "bg-emerald-500/40" : "bg-border"}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}
