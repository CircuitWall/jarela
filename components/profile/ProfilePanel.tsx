"use client";
import { Sparkles, User } from "lucide-react";
import { useRef, useState } from "react";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { useAppContext } from "@/contexts/AppContext";
import { OnboardingWizard } from "@/components/setup/OnboardingWizard";
import { ProfileEditor } from "./ProfileEditor";
import { SecurityPanel } from "./SecurityPanel";
import { RedactionPanel } from "./RedactionPanel";

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
                Setup wizard is open. You can return to profile anytime.
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowWizard(false);
              }}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg"
            >
              Back to profile
            </button>
          </div>
        </div>
        <OnboardingWizard context="profile" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <User size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg">User Profile</h2>
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
      </div>
      <div ref={containerRef} className="flex-1 overflow-y-auto no-scrollbar max-w-lg mx-auto w-full">
        <ProfileEditor />
        <div className="px-4 pb-6">
          <SecurityPanel />
          <RedactionPanel />
        </div>
      </div>
    </div>
  );
}
