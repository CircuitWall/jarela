import { NextRequest } from "next/server";
import { cachedJson } from "@/lib/api/responses";

interface CurrencyResponse {
  currency: string;
  rate_from_usd: number;
  country_code: string | null;
  source: "location" | "default" | "manual";
  updated_at: string;
}

const FX_TTL_MS = 12 * 60 * 60 * 1000;
const COUNTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let fxCache: { fetchedAt: number; rates: Record<string, number> } | null = null;
const currencyByCountry = new Map<string, { currency: string; fetchedAt: number }>();

export async function GET(req: NextRequest) {
  const manualCurrencyRaw = req.nextUrl.searchParams.get("currency");
  const manualCurrency =
    manualCurrencyRaw && /^[A-Za-z]{3}$/.test(manualCurrencyRaw)
      ? manualCurrencyRaw.toUpperCase()
      : null;
  const lat = Number(req.nextUrl.searchParams.get("lat"));
  const lng = Number(req.nextUrl.searchParams.get("lng"));
  const countryRaw = req.nextUrl.searchParams.get("country");
  const country =
    countryRaw && /^[A-Za-z]{2}$/.test(countryRaw)
      ? countryRaw.toUpperCase()
      : null;

  if (manualCurrency) {
    try {
      return await currencyResponse(manualCurrency, null, "manual");
    } catch (err) {
      console.warn("[currency] manual lookup failed, falling back to USD:", err);
      return defaultCurrencyResponse();
    }
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    if (country) {
      try {
        return await currencyResponse(await resolveCurrencyForCountry(country), country, "location");
      } catch (err) {
        console.warn("[currency] country lookup failed, falling back to USD:", err);
      }
    }
    return defaultCurrencyResponse();
  }

  try {
    const countryCode = await reverseCountryCode(lat, lng);
    if (!countryCode) return defaultCurrencyResponse();
    return await currencyResponse(await resolveCurrencyForCountry(countryCode), countryCode, "location");
  } catch (err) {
    console.warn("[currency] location lookup failed, falling back to USD:", err);
    return defaultCurrencyResponse();
  }
}

function defaultCurrencyResponse(countryCode: string | null = null) {
  return formatCurrencyResponse("USD", 1, countryCode, "default");
}

function formatCurrencyResponse(
  currency: string, rate: number, countryCode: string | null, source: CurrencyResponse["source"],
) {
  return cachedJson<CurrencyResponse>({
    currency,
    rate_from_usd: rate,
    country_code: countryCode,
    source,
    updated_at: new Date().toISOString(),
  }, 3600);
}

async function currencyResponse(currency: string | null, countryCode: string | null, source: CurrencyResponse["source"]) {
  if (!currency) return defaultCurrencyResponse(countryCode);
  if (currency === "USD") return formatCurrencyResponse(currency, 1, countryCode, source);
  const rate = (await fetchFxRates())[currency];
  if (!rate || !Number.isFinite(rate) || rate <= 0) return defaultCurrencyResponse(countryCode);
  return formatCurrencyResponse(currency, rate, countryCode, source);
}

async function reverseCountryCode(lat: number, lng: number): Promise<string | null> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("zoom", "3");
  url.searchParams.set("addressdetails", "1");

  const res = await fetch(url.toString(), {
    headers: {
      "user-agent": "jarela-dashboard-currency/1.0",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return null;
  const body = await res.json() as {
    address?: {
      country_code?: string;
    };
  };
  const cc = body.address?.country_code?.toUpperCase() ?? null;
  return cc && cc.length === 2 ? cc : null;
}

async function resolveCurrencyForCountry(countryCode: string): Promise<string | null> {
  const now = Date.now();
  const cached = currencyByCountry.get(countryCode);
  if (cached && now - cached.fetchedAt < COUNTRY_TTL_MS) return cached.currency;

  const res = await fetch(`https://restcountries.com/v3.1/alpha/${countryCode}?fields=currencies`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return null;
  const body = await res.json() as Array<{ currencies?: Record<string, { name?: string }> }>;
  const first = body[0]?.currencies ? Object.keys(body[0].currencies)[0] : null;
  if (!first) return null;
  currencyByCountry.set(countryCode, { currency: first.toUpperCase(), fetchedAt: now });
  return first.toUpperCase();
}

async function fetchFxRates(): Promise<Record<string, number>> {
  const now = Date.now();
  if (fxCache && now - fxCache.fetchedAt < FX_TTL_MS) return fxCache.rates;

  const res = await fetch("https://open.er-api.com/v6/latest/USD", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`fx status ${res.status}`);

  const body = await res.json() as { rates?: Record<string, number> };
  const rates = body.rates ?? {};
  fxCache = { fetchedAt: now, rates };
  return rates;
}
