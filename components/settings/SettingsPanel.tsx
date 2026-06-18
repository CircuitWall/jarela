"use client";
import { Cpu, Globe, Key, Palette, ScrollText, ServerCog, Shapes } from "lucide-react";
import { useAppContext } from "@/contexts/AppContext";
import { CredentialsListPanel } from "@/components/credentials/CredentialsPanel";
import { NetworkPanel } from "@/components/integrations/NetworkPanel";
import { ModelsPanel } from "@/components/models/ModelsPanel";
import { HarnessPanel } from "@/components/harness/HarnessPanel";
import { LogsPanel } from "@/components/logs/LogsPanel";
import { EnvVarsPanel } from "@/components/env/EnvVarsPanel";
import { AppearancePanel } from "./AppearancePanel";

// Settings is the consolidated home for everything that used to live as
// its own top-level tab (credentials, models, harness, logs, defaults)
// plus appearance/networking. The individual Tab values still exist so
// deep links like ?tab=credentials and ?tab=models keep working — this
// surface is the new top-of-funnel for menu navigation.

type Sub =
  | "appearance"
  | "networking"
  | "credentials"
  | "models"
  | "harness"
  | "logs"
  | "defaults";

const SUBS: ReadonlyArray<{ id: Sub; label: string; icon: React.ReactNode; advancedOnly?: boolean }> = [
  { id: "appearance", label: "Appearance", icon: <Palette size={13} /> },
  { id: "networking", label: "Networking", icon: <Globe size={13} /> },
  { id: "credentials", label: "Credentials", icon: <Key size={13} /> },
  { id: "models", label: "Models", icon: <Cpu size={13} /> },
  { id: "harness", label: "Harness", icon: <Shapes size={13} />, advancedOnly: true },
  { id: "logs", label: "Logs", icon: <ScrollText size={13} />, advancedOnly: true },
  { id: "defaults", label: "Defaults", icon: <ServerCog size={13} />, advancedOnly: true },
];

const VALID = new Set<Sub>(SUBS.map((s) => s.id));

function parseSub(raw: string | undefined): Sub {
  if (raw && VALID.has(raw as Sub)) return raw as Sub;
  return "appearance";
}

export function SettingsPanel() {
  const { state, dispatch } = useAppContext();
  const isFullMode = state.experienceMode === "full";
  const active = parseSub(state.selectedItem.settings);

  const setSub = (s: Sub) =>
    dispatch({ type: "SET_SELECTION", tab: "settings", itemId: s });

  const visibleSubs = SUBS.filter((s) => isFullMode || !s.advancedOnly);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        role="tablist"
        aria-label="Settings sub-section"
        className="flex items-stretch gap-4 px-4 border-b border-[var(--border)] bg-[var(--bg-secondary)] overflow-x-auto no-scrollbar"
      >
        {visibleSubs.map((s) => {
          const selected = s.id === active;
          return (
            <button
              key={s.id}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setSub(s.id)}
              className={
                "inline-flex items-center gap-1.5 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors " +
                (selected
                  ? "border-[var(--accent)] text-[var(--text-primary)] font-medium"
                  : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
              }
            >
              <span className="text-fg-subtle">{s.icon}</span>
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {active === "appearance" && <AppearancePanel />}
        {active === "networking" && <NetworkPanel />}
        {active === "credentials" && <CredentialsListPanel />}
        {active === "models" && <ModelsPanel />}
        {active === "harness" && <HarnessPanel />}
        {active === "logs" && <LogsPanel />}
        {active === "defaults" && <EnvVarsPanel />}
      </div>
    </div>
  );
}
