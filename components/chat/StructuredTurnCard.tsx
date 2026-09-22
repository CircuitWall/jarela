"use client";
import { useState } from "react";
import type { ReactNode } from "react";
import { Bot, Clock, Eye, Globe, MessageCircle, Zap } from "lucide-react";
import { CollapseChevron } from "@/components/ui/CollapseChevron";

// Small source-channel badge shown at the top of assistant bubbles that
// were triggered by automation (bridge reply, scheduled task reply, etc.).
// Lets the user tell at a glance which automation channel generated the
// response without needing to scroll up to the corresponding user bubble.
export const CATEGORY_BADGE: Record<string, { label: string; Icon: React.ElementType; cls: string }> = {
  scheduled_task: { label: "Scheduled", Icon: Clock,          cls: "text-violet-400/90 border-violet-500/30 bg-violet-950/30" },
  watcher:        { label: "Watcher",   Icon: Eye,            cls: "text-amber-400/90  border-amber-500/30  bg-amber-950/30" },
  bridge:         { label: "Bridge",    Icon: MessageCircle,  cls: "text-sky-400/90    border-sky-500/30    bg-sky-950/30" },
  page_capture:   { label: "Capture",   Icon: Globe,          cls: "text-teal-400/90   border-teal-500/30   bg-teal-950/30" },
  extension:      { label: "Extension", Icon: Zap,            cls: "text-indigo-400/90 border-indigo-500/30 bg-indigo-950/30" },
  synthetic:      { label: "System",    Icon: Bot,            cls: "text-fg-faint      border-border/40     bg-surface-2" },
};

// Same chip used on the user-bubble side of an automated turn (extension,
// bridge, capture, scheduled task, watcher). Bare label — no "reply"
// suffix — so the chip reads as a source tag, not a response indicator.
function UserCategoryChip({ category }: { category: string }) {
  const def = CATEGORY_BADGE[category];
  if (!def) return null;
  const { label, Icon, cls } = def;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[9.5px] font-medium shrink-0 ${cls}`}>
      <Icon size={9} className="shrink-0" />
      <span>{label}</span>
    </span>
  );
}

// Compact disclosure used inside every automation-turn card so each
// section (instruction, context, captured content, change diff) has the
// same chevron + label affordance.
export function CollapsibleSection({
  label,
  defaultOpen,
  accent,
  hint,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  accent: boolean;
  hint?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 text-left text-[10.5px] ${accent ? "text-white/75 hover:text-white/95" : "text-fg-muted hover:text-fg"}`}
        aria-expanded={open}
      >
        <CollapseChevron open={open} size={11} />
        <span className="uppercase tracking-wide">{label}</span>
        {hint && <span className={`ml-1 normal-case ${accent ? "text-white/55" : "text-fg-faint"}`}>{hint}</span>}
      </button>
      {open && <div className="pl-4 min-w-0">{children}</div>}
    </div>
  );
}

// Shared skeleton for every automation-turn user bubble. Top row is a
// small category chip + icon + title; an optional chip row holds metadata
// pills (host, selector, dm/group); the body is a list of collapsible
// sections. This keeps extension/bridge/capture/trigger/delegate bubbles
// visually consistent so the operator can scan an automation thread quickly.
export function StructuredTurnCard({
  categoryKey,
  Icon,
  title,
  titleTooltip,
  chips,
  sections,
  accent,
}: {
  categoryKey: string | null;
  Icon: React.ElementType;
  title: string;
  titleTooltip?: string;
  chips?: ReactNode;
  sections: Array<{ label: string; content: ReactNode; defaultOpen?: boolean; hint?: string }>;
  accent: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
        {categoryKey && <UserCategoryChip category={categoryKey} />}
        <Icon size={12} className={`shrink-0 ${accent ? "text-white/85" : "text-fg-muted"}`} />
        <span
          className={`text-[13px] font-medium truncate min-w-0 ${accent ? "text-white/95" : "text-fg"}`}
          title={titleTooltip}
        >
          {title}
        </span>
      </div>
      {chips && (
        <div className={`flex flex-wrap items-center gap-1.5 text-[10px] ${accent ? "text-white/75" : "text-fg-faint"}`}>
          {chips}
        </div>
      )}
      {sections.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {sections.map((s, i) => (
            <CollapsibleSection
              key={i}
              label={s.label}
              defaultOpen={s.defaultOpen}
              hint={s.hint}
              accent={accent}
            >
              {s.content}
            </CollapsibleSection>
          ))}
        </div>
      )}
    </div>
  );
}
