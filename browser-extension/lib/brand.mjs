// Brand identity for the browser extension.
//
// Single source of truth for every user-visible product string in the
// extension. `scripts/build-extension.mjs` regenerates this file from an
// optional `brand.json` when producing a rebranded build, so keep the shape
// below stable and the values plain literals.
//
// NOT branded on purpose (these are internal identifiers, not product
// names — renaming them would orphan stored config and injected styles,
// same rationale ADR-0005 used for DB table names):
//   - chrome.storage keys (`jarelaConfig`, `jarelaSelectedAgentId`)
//   - DOM ids (`#__jarela-overlay`, `#__jarela-banner`)
//   - CSS class + keyframe names (`.jarela-send-pill`, `jarela-fly`, …)

export const BRAND = Object.freeze({
  // Product name, as it appears in prose ("Open Jarela", "Jarela picker").
  name: "Jarela",
  // Short label for tight UI (toolbar titles, headings).
  shortName: "Jarela",
  // Extension manifest description.
  description:
    "Browser companion for Jarela: pick page elements, fill fields, rewrite text, and open the side panel.",
  // Accent used by the injected picker chrome (outline, flash, send pill).
  // Mirrors the --brand-accent fallback in content.css.
  accentColor: "#3b82f6",
});

// Upstream project. Deliberately NOT part of the rebrandable surface —
// build-extension.mjs never templates these, so every rebranded build keeps
// crediting the upstream project. Mirrors UPSTREAM_NAME / UPSTREAM_URL in
// lib/env/app-config.ts on the web side.
export const UPSTREAM_NAME = "Jarela";
export const UPSTREAM_URL = "https://github.com/CircuitWall/jarela";

// True when this build has been rebranded away from upstream. The
// "Powered by Jarela" credit only renders in that case — showing it inside
// the upstream build itself would just be noise.
export function isRebranded() {
  return BRAND.name !== UPSTREAM_NAME;
}

// Expand `{name}` / `{shortName}` placeholders in a template string.
export function brandText(template) {
  return String(template)
    .replaceAll("{name}", BRAND.name)
    .replaceAll("{shortName}", BRAND.shortName);
}

// Apply brand strings to a DOM subtree. MV3 forbids inline <script>, so
// markup ships placeholder templates in `data-brand-template` /
// `data-brand-title-template` attributes and the owning script calls this
// once the module is available.
//
// `root` may be a Document, an Element, or a ShadowRoot — content scripts
// render into a closed shadow root and must keep their message listeners
// synchronous, so they paint the templates first and brand them when the
// dynamic import resolves.
//
// Usage in markup:
//   <title data-brand-template="{name} Extension"></title>
//   <h1 data-brand-template="{name} Page Capture"></h1>
export function applyBrand(root = document) {
  for (const el of root.querySelectorAll("[data-brand-template]")) {
    el.textContent = brandText(el.getAttribute("data-brand-template"));
  }
  for (const el of root.querySelectorAll("[data-brand-title-template]")) {
    el.setAttribute("title", brandText(el.getAttribute("data-brand-title-template")));
  }
  // Only a Document exposes documentElement; shadow roots inherit the
  // property from the host page instead.
  root.documentElement?.style.setProperty("--brand-accent", BRAND.accentColor);
}

// Render the non-removable upstream credit into `container`. No-op for the
// upstream build itself (see isRebranded).
export function mountUpstreamCredit(container, doc = document) {
  if (!container || !isRebranded()) return;
  const a = doc.createElement("a");
  a.href = UPSTREAM_URL;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  a.className = "powered-by";
  a.textContent = `Powered by ${UPSTREAM_NAME}`;
  container.appendChild(a);
}
