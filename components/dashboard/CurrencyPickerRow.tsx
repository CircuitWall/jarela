"use client";
import type { DashboardCurrencyInfo } from "@/api/types";
import { MANUAL_CURRENCIES, type CurrencyMode } from "./dashboard-constants";

interface CurrencyPickerRowProps {
  currencyMode: CurrencyMode;
  onModeChange: (mode: CurrencyMode) => void;
  manualCurrency: string;
  onManualChange: (code: string) => void;
  currencyInfo: DashboardCurrencyInfo;
}

export function CurrencyPickerRow({ currencyMode, onModeChange, manualCurrency, onManualChange, currencyInfo }: CurrencyPickerRowProps) {
  return (
    <div className="relative flex flex-wrap items-center gap-2 px-1 py-1">
      <span className="text-xs text-[var(--text-secondary)]">Currency</span>
      <div className="inline-flex rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/80 p-0.5 text-xs">
        <button
          type="button"
          onClick={() => onModeChange("auto")}
          className={`px-2 py-0.5 rounded transition-colors ${
            currencyMode === "auto"
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          Auto
        </button>
        <button
          type="button"
          onClick={() => onModeChange("manual")}
          className={`px-2 py-0.5 rounded transition-colors ${
            currencyMode === "manual"
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          Manual
        </button>
      </div>
      {currencyMode === "manual" ? (
        <select
          value={manualCurrency}
          onChange={(e) => onManualChange(e.target.value)}
          className="rounded-md bg-[var(--bg-primary)]/60 px-2 py-1 text-xs text-[var(--text-primary)]"
        >
          {MANUAL_CURRENCIES.map((code) => (
            <option key={code} value={code}>{code}</option>
          ))}
        </select>
      ) : (
        <span className="text-[11px] text-[var(--text-secondary)]">
          using <span className="text-[var(--text-primary)] font-medium">{currencyInfo.currency}</span>
          {currencyInfo.country_code ? ` (${currencyInfo.country_code})` : ""}
        </span>
      )}
    </div>
  );
}
