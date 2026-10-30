import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fetchMock = vi.fn<typeof fetch>();
let GET: typeof import("./route").GET;

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  GET = (await import("./route")).GET;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function lookup(params: string) {
  const response = await GET(new NextRequest(`http://localhost/api/v1/dashboard/currency?${params}`));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("3600");
  return response.json();
}

describe("currency resolution contract", () => {
  it("uses explicit USD without looking up location or rates", async () => {
    expect(await lookup("currency=usd&country=GB")).toMatchObject({
      currency: "USD", rate_from_usd: 1, country_code: null, source: "manual",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses manual FX and reuses the cached rates", async () => {
    fetchMock.mockResolvedValue(Response.json({ rates: { EUR: 0.9 } }));
    for (let i = 0; i < 2; i++) {
      expect(await lookup("currency=eur")).toMatchObject({
        currency: "EUR", rate_from_usd: 0.9, country_code: null, source: "manual",
      });
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([undefined, 0, -1, "wrong"])("falls back for unusable manual rates: %s", async (rate) => {
    fetchMock.mockResolvedValue(Response.json({ rates: { EUR: rate } }));
    expect(await lookup("currency=EUR")).toMatchObject({
      currency: "USD", rate_from_usd: 1, country_code: null, source: "default",
    });
  });

  it.each([
    [{ GBP: {} }, { GBP: 0.8 }, "GBP", 0.8, "location"],
    [{ USD: {} }, null, "USD", 1, "location"],
    [{}, null, "USD", 1, "default"],
    [{ GBP: {} }, {}, "USD", 1, "default"],
  ] as const)("resolves country lookup and preserves country on rate fallback: %j", async (currencies, rates, currency, rate, source) => {
    fetchMock.mockResolvedValueOnce(Response.json([{ currencies }]));
    if (rates) fetchMock.mockResolvedValueOnce(Response.json({ rates }));
    expect(await lookup("lat=invalid&country=gb")).toMatchObject({
      currency, rate_from_usd: rate, country_code: "GB", source,
    });
    expect(fetchMock.mock.calls[0][0]).toContain("restcountries.com");
  });

  it("uses reverse geocoding before country and FX lookup", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ address: { country_code: "gb" } }))
      .mockResolvedValueOnce(Response.json([{ currencies: { GBP: {} } }]))
      .mockResolvedValueOnce(Response.json({ rates: { GBP: 0.8 } }));
    expect(await lookup("lat=51&lng=0&country=US")).toMatchObject({
      currency: "GBP", rate_from_usd: 0.8, country_code: "GB", source: "location",
    });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).hostname))
      .toEqual(["nominatim.openstreetmap.org", "restcountries.com", "open.er-api.com"]);
  });

  it.each(["currency=EUR", "lat=invalid&country=GB", "lat=51&lng=0"])("logs lookup failures and returns the legacy default: %s", async (params) => {
    fetchMock.mockRejectedValue(new Error("synthetic upstream failure"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await lookup(params)).toMatchObject({
      currency: "USD", rate_from_usd: 1, country_code: null, source: "default",
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});
