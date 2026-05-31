// Currency + number formatting used by the dashboard. Centralised so the
// "lowest first" sorts and compact donut center labels share one
// definition.

export interface CurrencyConversion {
  currency: string;
  rate_from_usd: number;
}

export function convertUsd(usd: number, currencyInfo: CurrencyConversion): number {
  const rate = Number.isFinite(currencyInfo.rate_from_usd) && currencyInfo.rate_from_usd > 0
    ? currencyInfo.rate_from_usd
    : 1;
  return usd * rate;
}

export function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatMoney(usd: number, currencyInfo: CurrencyConversion): string {
  const converted = convertUsd(usd, currencyInfo);
  const abs = Math.abs(converted);
  const useMicroPrecision = abs > 0 && abs < 0.01;
  const minFractionDigits = useMicroPrecision ? 4 : 2;
  const maxFractionDigits = useMicroPrecision ? 8 : 4;
  const code = currencyInfo.currency || "USD";

  if (abs > 0 && abs < 0.000001) {
    try {
      const floor = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: code,
        minimumFractionDigits: 6,
        maximumFractionDigits: 6,
      }).format(0.000001);
      return `< ${floor}`;
    } catch {
      return `${code} < 0.000001`;
    }
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: minFractionDigits,
      maximumFractionDigits: maxFractionDigits,
    }).format(converted);
  } catch {
    return `${code} ${converted.toFixed(maxFractionDigits)}`;
  }
}

export function formatMoneyCompact(usd: number, currencyInfo: CurrencyConversion): string {
  const converted = convertUsd(usd, currencyInfo);
  const code = currencyInfo.currency || "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(converted);
  } catch {
    const sign = converted < 0 ? "-" : "";
    const abs = Math.abs(converted);
    if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
    return `${sign}${abs.toFixed(2)}`;
  }
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
