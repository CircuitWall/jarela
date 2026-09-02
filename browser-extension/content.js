// Element picker overlay + send animation.
//
// Injected on demand by background.js when the toolbar icon is clicked.
// The script is idempotent — re-injection is a no-op (early return).
//
// The picker is intentionally OBVIOUS:
//   - A dark banner pinned to the top of the viewport explains the mode.
//   - Hovered elements get a 2px dashed blue outline + soft tinted fill.
//   - On click, the picked element flashes and a "Sent to <app>" pill
//     animates from the element bounding box toward the top-right corner
//     where the toolbar icon sits, then the banner shows the result.
//   - ESC cancels without sending.
//
// Pure-logic helpers live in lib/helpers.mjs and are dynamically imported
// so the same code is exercised by the vitest suite.

(async () => {
  if (window.__jarelaPickerActive) return;
  window.__jarelaPickerActive = true;

  const helpers = await import(chrome.runtime.getURL("lib/helpers.mjs"));
  const { BRAND, applyBrand } = await import(chrome.runtime.getURL("lib/brand.mjs"));
  // Stamps --brand-accent on the host page so the injected content.css
  // picker chrome uses this build's accent.
  applyBrand();

  const overlay = document.createElement("div");
  overlay.id = "__jarela-overlay";

  const banner = document.createElement("div");
  banner.id = "__jarela-banner";
  banner.textContent = `${BRAND.name} picker — click an element to capture it. ESC to cancel.`;

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(banner);

  let currentTarget = null;

  function moveOverlay(rect) {
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  function onMouseMove(ev) {
    const t = ev.target;
    if (!t || t === overlay || t === banner || t.closest?.("#__jarela-overlay,#__jarela-banner,.jarela-send-pill")) {
      return;
    }
    currentTarget = t;
    const r = t.getBoundingClientRect();
    moveOverlay(r);
  }

  function teardown() {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    banner.remove();
    window.__jarelaPickerActive = false;
  }

  async function onClick(ev) {
    if (!currentTarget) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    const target = currentTarget;
    const rect = target.getBoundingClientRect();
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);

    // Visual feedback BEFORE the network round-trip so it feels snappy.
    target.classList.add("jarela-flash-pulse");
    spawnSendPill(rect);
    banner.textContent = `Sending to ${BRAND.name}…`;
    banner.classList.add("jarela-sending");

    // Grab a screenshot of just this element. We hide the picker chrome
    // first so it doesn't end up in the cropped PNG. Best-effort: any
    // failure (cross-origin tab, captureVisibleTab denied) falls through
    // to a text-only capture.
    let screenshot = null;
    try {
      screenshot = await captureElementScreenshot(target, rect);
    } catch (err) {
      console.warn("[jarela] element screenshot failed:", err);
    }

    const payload = helpers.composePayload({
      url: location.href,
      title: document.title,
      selector: helpers.buildCssSelector(target),
      tagName: target.tagName,
      text: (target.innerText || target.textContent || "").trim(),
      capturedAt: new Date().toISOString(),
      screenshot: screenshot?.data ?? undefined,
      screenshotMediaType: screenshot?.mediaType ?? undefined,
    });

    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "jarela-capture", payload });
    } catch (err) {
      res = { ok: false, body: { error: String(err) } };
    }

    target.classList.remove("jarela-flash-pulse");
    banner.classList.remove("jarela-sending");

    if (res?.ok) {
      const b = res.body ?? {};
      const where = b.agent_name
        ? (b.created_thread
            ? ` to ${b.agent_name} (new thread)`
            : ` to ${b.agent_name}${b.thread_title ? ` — “${b.thread_title}”` : ""}`)
        : "";
      const tail = b.truncated
        ? ` · truncated to 100KB (original ${b.originalBytes.toLocaleString()} bytes)`
        : "";
      banner.textContent = `✓ Sent${where}${tail}. Open ${BRAND.name} to ask a question.`;
      banner.classList.add("jarela-success");
    } else {
      const errMsg = res?.body?.error ?? `HTTP ${res?.status ?? "?"}`;
      banner.textContent = `✗ Couldn't send: ${errMsg}`;
      banner.classList.add("jarela-error");
    }

    setTimeout(teardown, 2500);
  }

  function onKey(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      teardown();
    }
  }

  function spawnSendPill(fromRect) {
    const pill = document.createElement("div");
    pill.className = "jarela-send-pill";
    pill.textContent = "✈ Sent";
    pill.style.top = `${fromRect.top + window.scrollY}px`;
    pill.style.left = `${fromRect.left + window.scrollX}px`;
    document.documentElement.appendChild(pill);
    // Animate to top-right (where the toolbar icon lives) using a CSS
    // custom property the keyframes interpolate against.
    requestAnimationFrame(() => {
      pill.style.setProperty("--dx", `${window.innerWidth - fromRect.left - 60}px`);
      pill.style.setProperty("--dy", `${-fromRect.top - 40}px`);
      pill.classList.add("jarela-send-pill-fly");
    });
    setTimeout(() => pill.remove(), 900);
  }

  // Capture a PNG of just the picked element. Asks background to grab a
  // PNG of the visible viewport (uses chrome.tabs.captureVisibleTab,
  // which we can't call from a content script), then crops it to the
  // intersection of the element rect and the viewport using an
  // OffscreenCanvas. devicePixelRatio scales the rect because the
  // captured PNG is at physical pixels. Returns null when the element
  // has no on-screen area (fully scrolled out) or the capture failed.
  async function captureElementScreenshot(_target, rect) {
    // Hide the picker chrome so the dashed outline + banner don't bleed
    // into the screenshot. The overlay/banner are still mounted at this
    // point (teardown runs later in onClick).
    const prevOverlayDisplay = overlay.style.display;
    const prevBannerDisplay = banner.style.display;
    const prevPillDisplay = [];
    for (const p of document.querySelectorAll(".jarela-send-pill")) {
      prevPillDisplay.push([p, p.style.display]);
      p.style.display = "none";
    }
    overlay.style.display = "none";
    banner.style.display = "none";

    let res;
    try {
      // One animation frame lets the layer recompose without the picker
      // chrome before the tab snapshot is taken.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      res = await chrome.runtime.sendMessage({ type: "jarela-capture-visible-tab" });
    } finally {
      overlay.style.display = prevOverlayDisplay;
      banner.style.display = prevBannerDisplay;
      for (const [p, d] of prevPillDisplay) p.style.display = d;
    }

    if (!res?.ok || typeof res.body?.dataUrl !== "string") {
      return null;
    }

    // Intersect element rect with the visible viewport (rect is in CSS
    // pixels relative to the viewport). Anything off-screen gets clipped
    // — captureVisibleTab only sees what was rendered.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(vw, rect.right);
    const bottom = Math.min(vh, rect.bottom);
    const cssW = right - left;
    const cssH = bottom - top;
    if (cssW <= 1 || cssH <= 1) return null;

    const dpr = window.devicePixelRatio || 1;
    const sx = Math.round(left * dpr);
    const sy = Math.round(top * dpr);
    const sw = Math.round(cssW * dpr);
    const sh = Math.round(cssH * dpr);

    const blob = await (await fetch(res.body.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
      // Clamp to actual bitmap size (some platforms report dpr=2 but
      // captureVisibleTab returns 1x; cropping past the edge throws).
      const clampedW = Math.min(sw, Math.max(1, bitmap.width - sx));
      const clampedH = Math.min(sh, Math.max(1, bitmap.height - sy));
      const canvas = new OffscreenCanvas(clampedW, clampedH);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, sx, sy, clampedW, clampedH, 0, 0, clampedW, clampedH);
      const outBlob = await canvas.convertToBlob({ type: "image/png" });
      const buf = await outBlob.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return { data: btoa(binary), mediaType: "image/png" };
    } finally {
      bitmap.close?.();
    }
  }

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
})();
