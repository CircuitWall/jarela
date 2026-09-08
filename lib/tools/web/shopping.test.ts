import { describe, expect, it } from "vitest";
import { _shoppingInternals } from "./shopping";

describe("shopping internals", () => {
  it("supports SE country code and rejects unsupported countries", () => {
    expect(_shoppingInternals.normalizeCountry("se")).toBe("SE");
    expect(_shoppingInternals.normalizeCountry("SE")).toBe("SE");
    expect(_shoppingInternals.normalizeCountry("NO")).toBeNull();
  });

  it("builds Prisjakt query with site constraint and specs", () => {
    const q = _shoppingInternals.buildPrisjaktQuery("SE", "iphone 17", "mobiltelefoner", {
      ram: "8GB",
      storage: "256GB",
    });
    expect(q).toContain("iphone 17");
    expect(q).toContain("mobiltelefoner");
    expect(q).toContain("8GB");
    expect(q).toContain("256GB");
    expect(q).toContain("site:www.prisjakt.nu");
  });

  it("detects Prisjakt product URLs", () => {
    expect(_shoppingInternals.looksLikePrisjaktProductUrl("https://www.prisjakt.nu/produkt.php?p=14969878")).toBe(true);
    expect(_shoppingInternals.looksLikePrisjaktProductUrl("https://www.prisjakt.nu/c/mobiltelefoner")).toBe(false);
    expect(_shoppingInternals.looksLikePrisjaktProductUrl("https://example.com/produkt.php?p=1")).toBe(false);
  });

  it("parses SEK prices in common formats", () => {
    expect(_shoppingInternals.parseSekPrice("9 990 kr")).toBe(9990);
    expect(_shoppingInternals.parseSekPrice("10,50 kr")).toBe(10.5);
    expect(_shoppingInternals.parseSekPrice("invalid")).toBeNull();
  });

  it("extracts min price, merchant count, rating, and category from page text", () => {
    const pageText = [
      "Det billigaste priset för Apple iPhone 17 256GB just nu är 9 990 kr.",
      "Prisjakt jämför priser och erbjudande från 38 butiker.",
      "4.7 av 5 stjärnor",
      "Kategori Mobiltelefoner Serie iPhone 17",
    ].join("\n");

    expect(_shoppingInternals.parseMinPrice(pageText)).toBe(9990);
    expect(_shoppingInternals.parseMerchantCount(pageText)).toBe(38);
    expect(_shoppingInternals.parseRating(pageText)).toBe(4.7);
    expect(_shoppingInternals.parseCategory(pageText)).toBe("Mobiltelefoner");
  });
});
