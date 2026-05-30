"use client";
import { User } from "lucide-react";
import { useRef } from "react";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { useAppContext } from "@/contexts/AppContext";
import { OnboardingWizard } from "@/components/setup/OnboardingWizard";
import { ProfileEditor } from "./ProfileEditor";

export function ProfilePanel() {
  const { state } = useAppContext();
  const isNormal = state.experienceMode === "normal";
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("profile", "profile", containerRef);

  if (isNormal) {
    return (
      <div className="h-full overflow-y-auto">
        <OnboardingWizard context="profile" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <User size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg">User Profile</h2>
      </div>
      <div ref={containerRef} className="flex-1 overflow-y-auto max-w-lg mx-auto w-full">
        <ProfileEditor />
      </div>
    </div>
  );
}
