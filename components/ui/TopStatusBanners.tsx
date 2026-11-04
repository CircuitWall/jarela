"use client";

import { CryptoFallbackBanner } from "@/components/ui/CryptoFallbackBanner";
import { ServerStatus } from "@/components/ui/ServerStatus";
import { UpdateAvailableBanner } from "@/components/ui/UpdateAvailableBanner";

export function TopStatusBanners() {
  return (
    <div
      data-testid="top-status-banners"
      className="fixed left-0 right-0 xl:right-[var(--workspace-navigation-width)] 2xl:left-[var(--workspace-agents-width)] z-[45] px-3 pt-2 pointer-events-none"
      style={{ top: "calc(3rem + var(--app-safe-top))" }}
    >
      <div className="mx-auto max-w-4xl flex flex-col gap-2">
        <CryptoFallbackBanner />
        <UpdateAvailableBanner />
        <ServerStatus />
      </div>
    </div>
  );
}
