// Element picker overlay + send animation.
//
// Injected on demand by background.js when the toolbar icon is clicked.
// The script is idempotent — re-injection is a no-op (early return).
//
// The picker is intentionally OBVIOUS:
//   - A dark banner pinned to the top of the viewport explains the mode.
//   - Hovered elements get a 2px dashed blue outline + soft tinted fill.
//   - On click, the picked element flashes and a "Sent to Jarela" pill
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

  const overlay = document.createElement("div");
  overlay.id = "__jarela-overlay";

  const banner = document.createElement("div");
  banner.id = "__jarela-banner";
  banner.textContent = "Jarela picker — click an element to capture it. ESC to cancel.";

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
    banner.textContent = "Sending to Jarela…";
    banner.classList.add("jarela-sending");

    const payload = helpers.composePayload({
      url: location.href,
      title: document.title,
      selector: helpers.buildCssSelector(target),
      tagName: target.tagName,
      text: (target.innerText || target.textContent || "").trim(),
      capturedAt: new Date().toISOString(),
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
      banner.textContent = `✓ Sent${where}${tail}. Open Jarela to ask a question.`;
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

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
})();
