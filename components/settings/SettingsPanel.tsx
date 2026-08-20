"use client";
import { Cpu, Globe, Key, Palette, ScrollText, ServerCog, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
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
import { StatusDot } from "@/components/ui/StatusDot";

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
  | "harness"
  | "privacy"
  | "appearance"
  | "networking"
  | "environment"
  | "logs";

const SUBS: ReadonlyArray<{ id: Sub; label: string; icon: React.ReactNode; advancedOnly?: boolean }> = [
  { id: "credentials", label: "Credentials", icon: <Key size={13} /> },
  { id: "models", label: "Models", icon: <Cpu size={13} /> },
  { id: "harness", label: "Harnesses", icon: <Cpu size={13} />, advancedOnly: true },
  { id: "privacy", label: "Privacy & security", icon: <ShieldCheck size={13} /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={13} /> },
  { id: "networking", label: "Networking", icon: <Globe size={13} /> },
  { id: "environment", label: "Environment", icon: <ServerCog size={13} />, advancedOnly: true },
  { id: "logs", label: "Logs", icon: <ScrollText size={13} />, advancedOnly: true },
];

const VALID = new Set<Sub>(SUBS.map((s) => s.id));

// Old sub-tab ids (pre-reorder) redirect to their new home so existing
// deep links and saved selections keep resolving.
const LEGACY_SUBS: Record<string, Sub> = {
  defaults: "environment",
  harness: "harness",
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
      <StatusDot tone="danger" size="xs" label="Needs setup" title="Needs setup" />
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
        {active === "harness" && <HarnessPanel />}
        {active === "privacy" && <PrivacySecurityPanel />}
        {active === "appearance" && <AppearancePanel />}
        {active === "networking" && <NetworkPanel />}
        {active === "environment" && <EnvVarsPanel />}
        {active === "logs" && <LogsPanel />}
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
      <SystemControlCard />
    </div>
  );
}

// Danger-zone controls: soft abort (kills every in-flight run without
// restarting the process) and full restart (relies on the supervisor to
// relaunch). Sits at the bottom of Privacy & security so it's out of
// the way for daily use but reachable when something is stuck.
function SystemControlCard() {
  const [busy, setBusy] = useState<"abort" | "restart" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onAbort = async () => {
    if (busy) return;
    if (!confirm("Abort every ongoing agent run and tool call?\n\nThe process keeps running; bridges, scheduler, and the DB stay up.")) {
      return;
    }
    setBusy("abort");
    setError(null);
    setStatus(null);
    try {
      const body = await api.system.abort("user clicked Abort in Settings");
      setStatus(`Aborted ${body.aborted} run(s).`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onRestart = async () => {
    if (busy) return;
    if (!confirm("Restart the Jarela server?\n\nIn-flight runs will be aborted; the supervisor (Task Scheduler / systemd / launchd) will relaunch the process. If you're running via `npm start`, you will have to relaunch manually.")) {
      return;
    }
    setBusy("restart");
    setError(null);
    setStatus(null);
    try {
      await api.system.restart("user clicked Restart in Settings");
      setStatus("Restart requested. The server will exit shortly; refresh once it is back up.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface-2/70 p-3">
      <h3 className="text-sm font-semibold text-fg">System control</h3>
      <p className="mt-1 text-xs text-fg-muted">
        Escape hatches when something is stuck. Aborting cancels every ongoing
        agent run and tool call without restarting the server. Restarting exits
        the process; a supervisor (Task Scheduler / systemd / launchd) will
        relaunch it.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => { void onAbort(); }}
          disabled={busy !== null}
          className="text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg disabled:opacity-50"
        >
          {busy === "abort" ? "Aborting…" : "Abort ongoing work"}
        </button>
        <button
          type="button"
          onClick={() => { void onRestart(); }}
          disabled={busy !== null}
          className="text-xs px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-400 disabled:opacity-50"
        >
          {busy === "restart" ? "Restarting…" : "Restart server"}
        </button>
      </div>
      {status && (
        <p className="mt-2 text-xs text-fg-muted">{status}</p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-400">Error: {error}</p>
      )}
    </section>
  );
}
