"use client";
import { Cpu, Globe, Key, Palette, ScrollText, ServerCog, Shapes, ShieldCheck } from "lucide-react";
import { useAppContext } from "@/contexts/AppContext";
import { CredentialsListPanel } from "@/components/credentials/CredentialsPanel";
import { NetworkPanel } from "@/components/integrations/NetworkPanel";
import { ModelsPanel } from "@/components/models/ModelsPanel";
import { HarnessPanel } from "@/components/harness/HarnessPanel";
import { LogsPanel } from "@/components/logs/LogsPanel";
import { EnvVarsPanel } from "@/components/env/EnvVarsPanel";
import { AppearancePanel } from "./AppearancePanel";
import { SecurityPanel } from "@/components/profile/SecurityPanel";
import { RedactionPanel } from "@/components/profile/RedactionPanel";
import { useSettingsAttention } from "@/hooks/useSettingsAttention";
import { SubTabBar, type SubTabItem } from "@/components/ui/SubTabBar";

// Settings is the consolidated home for everything that used to live as
// its own top-level tab (credentials, models, harness, logs, defaults)
// plus appearance/networking. The individual Tab values still exist so
// deep links like ?tab=credentials and ?tab=models keep working — this
// surface is the new top-of-funnel for menu navigation.
//
// Sub-tab order is user-flow ordered: most operators visit Settings for
// "add an API key" or "wire a model" first, then occasionally tweak
// appearance / network, and only rarely dip into the advanced tier.

type Sub =
  | "credentials"
  | "models"
  | "privacy"
  | "appearance"
  | "networking"
  | "environment"
  | "logs"
  | "harness";

const SUBS: ReadonlyArray<{ id: Sub; label: string; icon: React.ReactNode; advancedOnly?: boolean }> = [
  { id: "credentials", label: "Credentials", icon: <Key size={13} /> },
  { id: "models", label: "Models", icon: <Cpu size={13} /> },
  { id: "privacy", label: "Privacy & security", icon: <ShieldCheck size={13} /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={13} /> },
  { id: "networking", label: "Networking", icon: <Globe size={13} /> },
  { id: "environment", label: "Environment", icon: <ServerCog size={13} />, advancedOnly: true },
  { id: "logs", label: "Logs", icon: <ScrollText size={13} />, advancedOnly: true },
  { id: "harness", label: "Test runs", icon: <Shapes size={13} />, advancedOnly: true },
];

const VALID = new Set<Sub>(SUBS.map((s) => s.id));

// Old sub-tab ids (pre-reorder) redirect to their new home so existing
// deep links and saved selections keep resolving.
const LEGACY_SUBS: Record<string, Sub> = {
  defaults: "environment",
};

function parseSub(raw: string | undefined): Sub {
  if (!raw) return "credentials";
  const mapped = LEGACY_SUBS[raw] ?? raw;
  if (VALID.has(mapped as Sub)) return mapped as Sub;
  return "credentials";
}

export function SettingsPanel() {
  const { state, dispatch } = useAppContext();
  const isFullMode = state.experienceMode === "full";
  const active = parseSub(state.selectedItem.settings);
  const attention = useSettingsAttention();

  const setSub = (s: Sub) =>
    dispatch({ type: "SET_SELECTION", tab: "settings", itemId: s });

  const visibleSubs = SUBS.filter((s) => isFullMode || !s.advancedOnly);

  const needsAttention = (id: Sub): boolean =>
    (id === "credentials" && attention.credentials) ||
    (id === "models" && attention.models);

  const tabItems: SubTabItem<Sub>[] = visibleSubs.map((s) => ({
    id: s.id,
    label: s.label,
    icon: s.icon,
    badge: needsAttention(s.id) ? (
      <span
        aria-label="Needs setup"
        title="Needs setup"
        className="inline-block w-1.5 h-1.5 rounded-full bg-red-500"
      />
    ) : undefined,
  }));

  return (
    <div className="flex flex-col h-full min-h-0">
      <SubTabBar
        ariaLabel="Settings sub-section"
        tabs={tabItems}
        active={active}
        onChange={setSub}
      />
      <div className="flex-1 min-h-0 overflow-hidden">
        {active === "credentials" && <CredentialsListPanel />}
        {active === "models" && <ModelsPanel />}
        {active === "privacy" && <PrivacySecurityPanel />}
        {active === "appearance" && <AppearancePanel />}
        {active === "networking" && <NetworkPanel />}
        {active === "environment" && <EnvVarsPanel />}
        {active === "logs" && <LogsPanel />}
        {active === "harness" && <HarnessPanel />}
      </div>
    </div>
  );
}

// Privacy & security groups the local-encryption PIN / master-key flow
// with the per-conversation redaction rules. Both used to live under
// Profile, but neither is "about you" — they're settings the operator
// configures once and forgets. Composed inline so the route survives a
// future change to either panel without touching this file.
function PrivacySecurityPanel() {
  return (
    <div className="h-full overflow-y-auto no-scrollbar max-w-lg mx-auto w-full px-4 py-3 space-y-3">
      <SecurityPanel />
      <RedactionPanel />
    </div>
  );
}
