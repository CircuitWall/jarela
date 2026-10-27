"use client";
import { BarChart3, Bot, Brain, Calendar, ChevronDown, Settings, User, Wrench, type LucideIcon } from "lucide-react";
import { useAppContext, type Tab } from "@/contexts/AppContext";
import { useSettingsAttention } from "@/hooks/useSettingsAttention";
import { StatusDot } from "@/components/ui/StatusDot";
import type { AgentConfig } from "@/api/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSyncExternalStore } from "react";
import { AgentCardControls, type AgentCardSettings, type UpdateCardAgent } from "./AgentCardControls";

interface Props {
  activeTab: Tab;
  open?: boolean;
  onClose: () => void;
  onSetTab: (tab: Tab) => void;
  activeAgent?: (Pick<AgentConfig, "id" | "name" | "icon" | "identity" | "instructions"> & AgentCardSettings) | null;
  agentsLoading?: boolean;
  agentsError?: string | null;
  onUpdateAgent?: UpdateCardAgent;
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

const MD_REMARK_PLUGINS = [remarkGfm];

const DESKTOP_QUERY = "(min-width: 80rem)";
function subscribeDesktop(onChange: () => void) {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
function desktopSnapshot() {
  return window.matchMedia(DESKTOP_QUERY).matches;
}
function serverDesktopSnapshot() {
  return false;
}

function AgentMarkdown({ children }: { children: string }) {
  return (
    <div className="jarela-rich prose-invert min-w-0 break-words text-xs leading-relaxed text-fg-muted [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_pre]:p-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_th]:px-2 [&_td]:px-2">
      <ReactMarkdown
        remarkPlugins={MD_REMARK_PLUGINS}
        skipHtml
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          // Descriptions must not load remote images, including in the hidden mobile card.
          img: ({ alt }) => <span className="italic text-fg-faint">{alt}</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function MenuPanel({ activeTab, open = true, onClose, onSetTab, activeAgent, agentsLoading = false, agentsError, onUpdateAgent }: Props) {
  const { state } = useAppContext();
  const isFullMode = state.experienceMode === "full";
  const attention = useSettingsAttention();
  const isDesktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, serverDesktopSnapshot);

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
      id="main-navigation"
      aria-label="Main navigation"
      className={`glass-elevated fixed right-0 bottom-0 w-full sm:w-[26rem] xl:w-[var(--workspace-navigation-width)] max-w-full border-l border-border/60 z-[60] ${open ? "flex" : "hidden xl:flex"} flex-col pb-safe`}
      style={{ top: "calc(3rem + var(--app-safe-top))" }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain panel-scrollbar px-3 py-3 space-y-4">
        <section key={activeAgent?.id} aria-labelledby="menu-selected-agent" className="hidden rounded-2xl border border-border/60 bg-surface-2/50 p-3 xl:block">
          <h2 id="menu-selected-agent" className="pb-3 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Selected agent</h2>
          {agentsError ? (
            <p className="text-xs text-fg-muted" role="status">Could not load agent details: {agentsError}</p>
          ) : agentsLoading && !activeAgent ? (
            <p className="text-xs text-fg-faint" role="status">Loading agent details...</p>
          ) : activeAgent ? (
            <div className="min-w-0 space-y-3">
              <div className="flex min-w-0 items-center gap-3">
                {activeAgent.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={activeAgent.icon} alt="" className="h-12 w-12 shrink-0 rounded-xl object-cover" />
                ) : (
                  <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-lg font-semibold text-accent">
                    {activeAgent.name.charAt(0).toUpperCase()}
                  </span>
                )}
                <h3 className="min-w-0 break-words text-sm font-semibold">{activeAgent.name}</h3>
              </div>
              <div
                role="region"
                aria-label="Agent description"
                tabIndex={0}
                className="panel-scrollbar max-h-64 min-w-0 space-y-4 overflow-y-auto overscroll-contain rounded-lg focus-visible:outline-2 focus-visible:outline-accent"
              >
                <div>
                  <h4 className="mb-1 text-[11px] font-semibold text-fg-faint">Identity</h4>
                  {activeAgent.identity.trim()
                    ? <AgentMarkdown>{activeAgent.identity}</AgentMarkdown>
                    : <p className="text-xs text-fg-faint">No identity set.</p>}
                </div>
                <div>
                  <h4 className="mb-1 text-[11px] font-semibold text-fg-faint">Instructions</h4>
                  {activeAgent.instructions.trim()
                    ? <AgentMarkdown>{activeAgent.instructions}</AgentMarkdown>
                    : <p className="text-xs text-fg-faint">No instructions set.</p>}
                </div>
              </div>
              {isDesktop && onUpdateAgent && <AgentCardControls agent={activeAgent} isFullMode={isFullMode} onUpdate={onUpdateAgent} />}
              <button
                type="button"
                onClick={() => { onSetTab("agents"); onClose(); }}
                className="control-tap min-h-11 w-full rounded-xl border border-border/60 px-3 py-2 text-left text-xs text-fg-muted hover:bg-surface-3/60 focus-visible:outline-2 focus-visible:outline-accent"
              >
                Manage agents
              </button>
            </div>
          ) : (
            <p className="text-xs text-fg-faint">Select an agent to see its details.</p>
          )}
        </section>
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
