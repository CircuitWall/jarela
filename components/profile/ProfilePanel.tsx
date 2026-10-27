"use client";
import { Sparkles, User } from "lucide-react";
import { PanelHeader } from "@/components/ui/PanelHeader";
import { useRef, useState } from "react";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { useAppContext } from "@/contexts/AppContext";
import { OnboardingWizard } from "@/components/setup/OnboardingWizard";
import { ProfileEditor } from "./ProfileEditor";

export function ProfilePanel() {
  const { state } = useAppContext();
  const isEssential = state.experienceMode === "essential";
  const containerRef = useRef<HTMLDivElement>(null);
  const [showWizard, setShowWizard] = useState(false);
  useDeepLinkScroll("profile", "profile", containerRef);

  if (isEssential && showWizard) {
    return (
      <div className="h-full overflow-y-auto no-scrollbar">
        <div className="max-w-3xl mx-auto w-full px-4 pt-4">
          <div className="rounded-xl border border-border bg-surface-2/70 px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <Sparkles size={14} className="text-accent" />
              <span>
                Credentials, models, and agents stay unchanged. Profile edits apply only when you finish.
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowWizard(false);
              }}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg"
            >
              Exit wizard
            </button>
          </div>
        </div>
        <OnboardingWizard context="profile" />
      </div>
    );
  }

  return (
    <div className="workspace-panel flex h-full flex-col">
      <PanelHeader icon={<User size={14} />} title="Profile">
        {isEssential && (
          <button
            type="button"
            onClick={() => {
              setShowWizard(true);
            }}
            className="ml-auto text-xs px-2.5 py-1 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg-muted hover:text-fg"
          >
            Run setup wizard again
          </button>
        )}
      </PanelHeader>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
        <ProfileEditor />
      </div>
    </div>
  );
}
