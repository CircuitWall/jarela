"use client";

import { useCallback, useEffect, useState } from "react";
import { Logo } from "@/components/ui/Logo";
import { OnboardingWizard } from "@/components/setup/OnboardingWizard";

export function FirstKeySetup() {
  const [wizardReady, setWizardReady] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const markWizardReady = useCallback(() => setWizardReady(true), []);

  useEffect(() => {
    if (!wizardReady) return;
    const reduceMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setShowWizard(true);
      return;
    }
    const timer = window.setTimeout(() => setShowWizard(true), 300);
    return () => window.clearTimeout(timer);
  }, [wizardReady]);

  return (
    <div className="relative min-h-screen bg-surface text-fg">
      <div
        data-testid="setup-boot-screen"
        role="status"
        aria-live="polite"
        aria-hidden={showWizard}
        className={`fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-surface text-fg transition-opacity duration-500 ease-out motion-reduce:transition-none ${showWizard ? "pointer-events-none opacity-0" : "opacity-100"}`}
      >
        <Logo className="boot-screen-logo h-16 w-auto" />
        <p className="min-h-5 px-6 text-center text-xs uppercase tracking-[0.2em] text-fg-faint animate-pulse">
          Preparing your first setup
        </p>
      </div>
      <div
        aria-hidden={!showWizard}
        inert={!showWizard}
        className={`relative min-h-screen transition-opacity duration-500 ease-out motion-reduce:transition-none ${showWizard ? "opacity-100" : "pointer-events-none opacity-0"}`}
      >
        <OnboardingWizard context="setup" onReady={markWizardReady} />
      </div>
    </div>
  );
}
