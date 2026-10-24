"use client";
import { BarChart3, Bot, Brain, Calendar, ChevronDown, Settings, User, Wrench, type LucideIcon } from "lucide-react";
import { useAppContext, type Tab } from "@/contexts/AppContext";
import { useSettingsAttention } from "@/hooks/useSettingsAttention";
import { StatusDot } from "@/components/ui/StatusDot";

interface Props {
  activeTab: Tab;
  onClose: () => void;
  onSetTab: (tab: Tab) => void;
}

interface MenuItem {
  tab: Tab;
  label: string;
  description: string;
  icon: LucideIcon;
  fullOnly?: boolean;
}

const WORKSPACE: MenuItem[] = [
  { tab: "agents", label: "Agents", description: "Create and configure your agents", icon: Bot },
  { tab: "memory", label: "Knowledge", description: "Search documents, chats, and saved facts", icon: Brain, fullOnly: true },
  { tab: "tasks", label: "Automations", description: "Manage scheduled and background work", icon: Calendar, fullOnly: true },
  { tab: "dashboard", label: "Usage", description: "Review activity and costs", icon: BarChart3, fullOnly: true },
];
const PREFERENCES: MenuItem[] = [
  { tab: "profile", label: "Profile", description: "Your identity and preferences", icon: User },
  { tab: "settings", label: "Settings", description: "Configure the app, models, and credentials", icon: Settings },
];
const ADVANCED: MenuItem[] = [
  { tab: "tools", label: "Capabilities", description: "Manage tools, integrations, and connections", icon: Wrench },
];

export function MenuPanel({ activeTab, onClose, onSetTab }: Props) {
  const { state } = useAppContext();
  const isFullMode = state.experienceMode === "full";
  const attention = useSettingsAttention();

  const renderItem = ({ tab, label, description, icon: Icon }: MenuItem) => {
    const needsAttention = tab === "settings" && attention.any;
    const reasons = [
      attention.models ? "no model configured" : null,
      attention.credentials ? "no credentials saved" : null,
    ].filter(Boolean).join(", ");
    return (
      <button
        key={tab}
        type="button"
        aria-label={label}
        aria-current={activeTab === tab ? "page" : undefined}
        title={needsAttention ? `${label} - ${reasons}` : undefined}
        onClick={() => { onSetTab(tab); onClose(); }}
        className={`control-tap flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
          activeTab === tab
            ? "bg-accent/10 text-fg ring-1 ring-accent/30"
            : "text-fg-muted hover:bg-surface-3/60 hover:text-fg"
        }`}
      >
        <span className="relative shrink-0" aria-hidden="true">
          <Icon size={19} />
          {needsAttention && <StatusDot tone="danger" size="sm" className="absolute -top-1 -right-1 ring-2 ring-surface-2" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{label}</span>
          <span className="block text-xs leading-relaxed text-fg-faint break-words">{description}</span>
          {needsAttention && <span className="block text-xs text-fg-muted">{reasons}</span>}
        </span>
      </button>
    );
  };

  return (
    <nav
      aria-label="Main navigation"
      className="glass-elevated fixed right-0 bottom-0 w-full sm:w-[26rem] max-w-full border-l border-border/60 z-[60] flex flex-col pb-safe"
      style={{ top: "calc(3rem + var(--app-safe-top))" }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain panel-scrollbar px-3 py-3 space-y-4">
        <section aria-labelledby="menu-workspace">
          <h2 id="menu-workspace" className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Workspace</h2>
          <div className="space-y-1">{WORKSPACE.filter((item) => isFullMode || !item.fullOnly).map(renderItem)}</div>
        </section>
        <section aria-labelledby="menu-preferences" className="border-t border-border/60 pt-3">
          <h2 id="menu-preferences" className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Preferences</h2>
          <div className="space-y-1">{PREFERENCES.map(renderItem)}</div>
        </section>
        {isFullMode && (
          <details open={ADVANCED.some((item) => item.tab === activeTab)} className="group border-t border-border/60 pt-2">
            <summary className="control-tap flex min-h-11 cursor-pointer list-none items-center justify-between rounded-xl px-3 text-[11px] font-semibold uppercase tracking-wide text-fg-faint hover:bg-surface-3/60 focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
              Advanced
              <ChevronDown size={15} aria-hidden="true" className="-rotate-90 transition-transform group-open:rotate-0" />
            </summary>
            <div className="space-y-1 pt-1">{ADVANCED.map(renderItem)}</div>
          </details>
        )}
      </div>
    </nav>
  );
}
