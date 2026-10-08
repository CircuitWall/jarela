"use client";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CollapseChevron } from "./CollapseChevron";

// Cards inside a <SettingsGroup> become drawers: one open at a time, the
// rest collapse to a title row. Outside a group a card is always expanded.
const GroupContext = createContext<{ openId: string | null; toggle: (id: string) => void } | null>(null);

export function SettingsGroup({ children, defaultOpenId = null }: { children: ReactNode; defaultOpenId?: string | null }) {
  const [openId, setOpenId] = useState<string | null>(defaultOpenId);
  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  return (
    <GroupContext.Provider value={{ openId, toggle }}>
      <div className="space-y-3">{children}</div>
    </GroupContext.Provider>
  );
}

// Titled card for one setting group inside a panel.
export function SettingsCard({
  title,
  icon,
  description,
  actions,
  children,
  id,
}: {
  title: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  id?: string;
}) {
  const group = useContext(GroupContext);
  const autoId = useId();
  const cardId = id ?? autoId;
  const open = group ? group.openId === cardId : true;
  const bodyId = `${cardId}-body`;
  const sectionRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(open);

  // After a drawer opens (and the one above it collapses) the card can end up
  // below the fold on a phone; bring it into view once the animation settles.
  useEffect(() => {
    const justOpened = group && open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened) return;
    const t = setTimeout(() => sectionRef.current?.scrollIntoView?.({ block: "nearest" }), 220);
    return () => clearTimeout(t);
  }, [open, group]);

  const heading = (
    <>
      {group && <CollapseChevron open={open} className="text-fg-faint" />}
      {icon && <span className="text-accent flex items-center">{icon}</span>}
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
    </>
  );

  return (
    <section ref={sectionRef} data-deep-link-id={id} className="rounded-xl border border-border bg-surface-2/70 p-4">
      <div className="flex items-center gap-2">
        {group ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => group.toggle(cardId)}
            className="control-tap touch-manipulation flex items-center gap-2 flex-1 min-w-0 text-left rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {heading}
          </button>
        ) : (
          <div className="flex items-center gap-2 flex-1 min-w-0">{heading}</div>
        )}
        {actions && open && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      <div
        id={bodyId}
        inert={!open}
        className={`grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="pt-3 space-y-3">
            {description && <p className="text-xs text-fg-muted">{description}</p>}
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}
