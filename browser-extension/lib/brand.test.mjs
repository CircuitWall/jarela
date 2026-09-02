import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BRAND, UPSTREAM_NAME, UPSTREAM_URL, brandText, isRebranded } from "./brand.mjs";
import {
  UPSTREAM_BRAND,
  brandManifest,
  renderBrandModule,
  resolveBrand,
} from "../../scripts/build-extension.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, "..");

describe("extension brand module", () => {
  it("ships the upstream identity by default", () => {
    expect(BRAND.name).toBe("Jarela");
    expect(BRAND.shortName).toBe("Jarela");
    expect(BRAND.accentColor).toBe("#3b82f6");
    expect(isRebranded()).toBe(false);
  });

  it("pins the upstream credit outside the rebrandable surface", () => {
    expect(UPSTREAM_NAME).toBe("Jarela");
    expect(UPSTREAM_URL).toBe("https://github.com/CircuitWall/jarela");
  });

  it("expands template placeholders", () => {
    expect(brandText("Open {name}")).toBe("Open Jarela");
    expect(brandText("{shortName} agent")).toBe("Jarela agent");
    expect(brandText("no placeholders")).toBe("no placeholders");
  });

  // content.css declares the same value as its standalone fallback; if one
  // moves without the other, rebranded and default chrome diverge.
  it("matches the --brand-accent fallback in content.css", () => {
    const css = readFileSync(resolve(extRoot, "content.css"), "utf8");
    expect(css).toContain(`--brand-accent: ${BRAND.accentColor};`);
  });
});

describe("build-extension brand resolution", () => {
  it("returns the upstream brand for an absent/empty brand file", () => {
    expect(resolveBrand(null)).toEqual(UPSTREAM_BRAND);
    expect(resolveBrand({})).toEqual(UPSTREAM_BRAND);
  });

  it("defaults shortName to the overridden name, not to Jarela", () => {
    expect(resolveBrand({ name: "Acme" }).shortName).toBe("Acme");
  });

  it("synthesizes a description when the fork omits one", () => {
    expect(resolveBrand({ name: "Acme" }).description).toBe("Browser companion for Acme.");
  });

  it("rejects a non-hex accent color", () => {
    expect(() => resolveBrand({ accentColor: "rebeccapurple" })).toThrow(/hex color/);
    expect(resolveBrand({ accentColor: "#7c3aed" }).accentColor).toBe("#7c3aed");
  });

  it("ignores blank overrides", () => {
    expect(resolveBrand({ name: "   " }).name).toBe("Jarela");
  });
});

describe("build-extension output parity", () => {
  const manifest = JSON.parse(readFileSync(resolve(extRoot, "manifest.json"), "utf8"));

  // Drift guard: a brand-less build must reproduce the in-tree manifest.
  it("reproduces the in-tree manifest when no brand is supplied", () => {
    expect(brandManifest(manifest, UPSTREAM_BRAND)).toEqual(manifest);
  });

  it("templates every product-name field", () => {
    const out = brandManifest(manifest, resolveBrand({ name: "Acme", description: "d" }));
    expect(out.name).toBe("Acme");
    expect(out.description).toBe("d");
    expect(out.action.default_title).toBe("Capture an element to Acme");
    expect(out.commands["fill-focused-field"].description).toBe(
      "Acme: open fill menu on focused field",
    );
    // Non-brand fields are untouched.
    expect(out.permissions).toEqual(manifest.permissions);
    expect(out.commands["fill-focused-field"].suggested_key).toEqual(
      manifest.commands["fill-focused-field"].suggested_key,
    );
  });

  it("rewrites only the BRAND literal in the generated module", () => {
    const template = readFileSync(resolve(extRoot, "lib", "brand.mjs"), "utf8");
    const out = renderBrandModule(resolveBrand({ name: "Acme", accentColor: "#7c3aed" }), template);
    expect(out).toContain('name: "Acme"');
    expect(out).toContain('accentColor: "#7c3aed"');
    expect(out).not.toContain('name: "Jarela"');
    // The upstream credit and helpers survive the rewrite.
    expect(out).toContain('export const UPSTREAM_NAME = "Jarela";');
    expect(out).toContain('export const UPSTREAM_URL = "https://github.com/CircuitWall/jarela";');
    expect(out).toContain("export function applyBrand(");
    expect(out).toContain("export function mountUpstreamCredit(");
  });
});
