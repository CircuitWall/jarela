"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, HardDrive, PackageCheck } from "lucide-react";
import { api } from "@/api/client";
import type { OptionalPackageStatusInfo, OptionalPackagesResponse } from "@/api/types";
import { pushErrorToast } from "@/lib/ui/error-report";
import { SettingsCard } from "@/components/ui/SettingsCard";

/**
 * Optional packages grouped by category (ADR-0122).
 *
 * The goal is expectation-setting: every row says what installing it turns on,
 * roughly how much disk it costs, and what keeps working without it. Installing
 * is an explicit click, never a side effect of browsing.
 */
export function OptionalPackages() {
  const [data, setData] = useState<OptionalPackagesResponse | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    try {
      const next = await api.dependencies.optional();
      setData(next);
      setError(null);
      if (force) setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function install(entry: OptionalPackageStatusInfo) {
    setBusy((b) => ({ ...b, [entry.id]: true }));
    try {
      const outcome = await api.dependencies.install(entry.target);
      if (outcome.status === "installed" || outcome.status === "already_ready") {
        await load();
        return;
      }
      if (outcome.status === "pending_approval") {
        pushErrorToast({
          title: `${entry.label} needs approval`,
          error: new Error("The publisher is not allowlisted. Approve the pending install under Tools → Packages."),
          context: { panel: "packages", package: entry.id },
        });
        return;
      }
      pushErrorToast({
        title: `Couldn't install ${entry.label}`,
        error: outcome.error ?? `Install ended as ${outcome.status}`,
        context: { panel: "packages", package: entry.id },
      });
    } catch (err) {
      pushErrorToast({ title: `Couldn't install ${entry.label}`, error: err, context: { panel: "packages", package: entry.id } });
    } finally {
      setBusy((b) => ({ ...b, [entry.id]: false }));
    }
  }

  const categories = data?.categories.filter((group) => group.packages.length > 0) ?? [];
  const anyMissing = categories.some((group) => group.packages.some((pkg) => pkg.state !== "satisfied"));
  if (!data || (categories.length === 0 && !error)) return null;

  return (
    <SettingsCard id="optional-packages" title="Optional packages">
      <p className="text-xs text-fg-faint">
        Big capabilities that are not installed by default. Nothing here is required:
        Jarela keeps working without it, and installing is a one-click action that can be undone.
      </p>
      {error && <p className="text-xs text-danger-fg">Optional packages unavailable: {error}</p>}
      {categories.map((group) => (
        <div key={group.id} className="mt-3 space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{group.label}</h4>
            {group.pendingSizeMb > 0 && (
              <span className="text-[11px] text-fg-faint">≈{group.pendingSizeMb} MB not installed</span>
            )}
          </div>
          {group.packages.map((pkg) => {
            const installed = pkg.state === "satisfied";
            return (
              <div
                key={pkg.id}
                className="rounded-md border border-border px-3 py-2 space-y-1"
              >
                <div className="flex items-center gap-2">
                  {installed
                    ? <PackageCheck size={13} className="text-success-fg shrink-0" />
                    : <HardDrive size={13} className="text-fg-faint shrink-0" />}
                  <span className="text-sm text-fg">{pkg.label}</span>
                  <span className="text-[11px] text-fg-faint font-mono">{pkg.id}</span>
                  <span className="ml-auto text-[11px] text-fg-faint">≈{pkg.sizeMb} MB</span>
                </div>
                <p className="text-xs text-fg-muted">{pkg.summary}</p>
                <p className="text-[11px] text-fg-faint">Without it: {pkg.withoutIt}</p>
                <div className="flex items-center gap-2 pt-1">
                  {installed ? (
                    <span className="text-[11px] text-success-fg">Installed</span>
                  ) : (
                    <button
                      onClick={() => void install(pkg)}
                      disabled={busy[pkg.id]}
                      className="text-xs px-2 py-1 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <Download size={12} />
                      {busy[pkg.id] ? "Installing..." : "Install"}
                    </button>
                  )}
                  {pkg.docsUrl && (
                    <a
                      href={pkg.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-fg-faint underline"
                    >
                      Package docs
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {!anyMissing && (
        <p className="text-[11px] text-fg-faint pt-2">All optional packages in this build are installed.</p>
      )}
    </SettingsCard>
  );
}
