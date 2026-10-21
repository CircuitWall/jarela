"use client";

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
    <ol className="flex w-full items-center justify-center gap-1" aria-label="Setup progress">
      {steps.map((step, idx) => {
        const isDone = idx < current;
        const isActive = idx === current;
        const reachable = isDone || isActive;
        const Tag = onJump && reachable ? "button" : "div";
        return (
          <li key={step.id} className="flex flex-1 items-center gap-1">
            <Tag
              type={onJump && reachable ? "button" : undefined}
              onClick={onJump && reachable ? () => onJump(idx) : undefined}
              aria-current={isActive ? "step" : undefined}
              title={step.title}
              className={`group inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${onJump && reachable ? "cursor-pointer" : "cursor-default"}`}
            >
              <span
                aria-hidden="true"
                className={`block rounded-full transition-colors ${
                  isActive
                    ? "h-2.5 w-2.5 bg-accent"
                    : isDone
                      ? "h-2 w-2 bg-emerald-500"
                      : "h-2 w-2 bg-border"
                }`}
              />
              <span className="sr-only">
                Step {idx + 1}: {step.title} ({isActive ? "current" : isDone ? "complete" : "upcoming"})
              </span>
            </Tag>
            {idx < steps.length - 1 && (
              <span aria-hidden="true" className={`h-px flex-1 ${isDone ? "bg-emerald-500/40" : "bg-border"}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}
