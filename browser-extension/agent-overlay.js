// Agent overlay — injected on demand by background.js into any
// tab the agent wants to drive. Renders two pieces of UI inside a closed
// Shadow DOM so page CSS can't restyle us:
//
//   1) Approval modal: blocking prompt with three choices —
//      "Approve once" / "Always allow on <host>" / "Deny".
//   2) Status banner: a non-blocking top-of-viewport strip that stays
//      visible while one or more commands are in flight. Includes a
//      "Stop" button that posts a deny-and-remember decision back to the
//      service worker.
//
// Coordination with the service worker is via `chrome.runtime.sendMessage`
// (modal choice) and `chrome.runtime.onMessage` (show/hide commands and
// approval requests). All messages carry `__jarela: true` so we can
// quickly filter out unrelated runtime messages.
//
// This file is loaded as a normal (classic) content script — it must not
// use `import` syntax, must guard against double-injection, and must
// avoid touching the page's globals.

(function () {
  if (window.__jarelaAgentOverlayInstalled) return;
  window.__jarelaAgentOverlayInstalled = true;

  const HOST_ID = "__jarela-agent-overlay-host";
  // A host left over from a prior extension context (e.g. after the
  // extension was reloaded or updated) still carries its old `mode:
  // "closed"` shadow root, which the new isolated-world context cannot
  // read back via `hostEl.shadowRoot`. attachShadow() would then throw
  // NotSupportedError. The safe move is to tear the orphan down and
  // rebuild from scratch — its event listeners belonged to the dead
  // context anyway.
  const stale = document.getElementById(HOST_ID);
  if (stale) stale.remove();
  const hostEl = document.createElement("div");
  hostEl.id = HOST_ID;
  // The host is positioned via fixed coordinates so it floats above
  // every page chrome. The contents live in a closed shadow root so
  // page rules can't restyle us.
  hostEl.style.cssText = [
    "all: initial",
    "position: fixed",
    "inset: 0",
    "pointer-events: none",
    "z-index: 2147483647",
  ].join(";");
  document.documentElement.appendChild(hostEl);
  const shadow = hostEl.attachShadow({ mode: "closed" });

  // Brand strings live in lib/brand.mjs so a rebranded build only has to
  // regenerate that one module. This file is a CLASSIC content script, so
  // the module arrives asynchronously — markup below paints
  // `data-brand-template` placeholders synchronously (keeping the message
  // listeners registered without delay) and `brandRoot` fills them in as
  // soon as the import resolves. Late-created UI (the approval modal) calls
  // brandRoot() again after it mounts.
  let applyBrand = null;
  const brandReady = import(chrome.runtime.getURL("lib/brand.mjs"))
    .then((m) => {
      applyBrand = m.applyBrand;
      applyBrand(shadow);
    })
    .catch(() => { /* non-fatal: placeholders stay empty rather than wrong */ });

  function brandRoot(root) {
    if (applyBrand) applyBrand(root);
    else brandReady.then(() => applyBrand?.(root));
  }

  const STYLE = `
    .banner {
      position: fixed; top: 0; left: 0; right: 0;
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px;
      background: rgba(13, 71, 161, 0.96);
      color: #fff;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
      pointer-events: auto;
      transform: translateY(-100%);
      transition: transform 220ms ease;
    }
    .banner.show { transform: translateY(0); }
    .banner .dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: #ffeb3b;
      box-shadow: 0 0 8px #ffeb3bcc;
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.4; transform: scale(0.9); }
      50%      { opacity: 1;   transform: scale(1.1); }
    }
    .banner .label { flex: 0 0 auto; font-weight: 600; }
    .banner .action { flex: 1 1 auto; opacity: 0.92; }
    .banner button {
      all: unset;
      cursor: pointer;
      padding: 4px 10px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
      font: inherit;
    }
    .banner button:hover { background: rgba(255, 255, 255, 0.28); }

    .frame {
      position: fixed; inset: 0;
      pointer-events: none;
      border: 3px solid rgba(13, 71, 161, 0.55);
      box-sizing: border-box;
      opacity: 0;
      transition: opacity 220ms ease;
    }
    .frame.show { opacity: 1; }

    .modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      display: flex; align-items: center; justify-content: center;
      pointer-events: auto;
      opacity: 0;
      transition: opacity 180ms ease;
    }
    .modal-backdrop.show { opacity: 1; }
    .modal {
      background: #fff;
      color: #111;
      width: min(420px, 90vw);
      padding: 22px 22px 18px;
      border-radius: 10px;
      box-shadow: 0 14px 60px rgba(0, 0, 0, 0.35);
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .modal h2 { margin: 0 0 8px; font-size: 17px; }
    .modal p { margin: 0 0 14px; }
    .modal .host {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      background: #f0f4ff;
      color: #1a3a8a;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }
    .modal .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .modal .risk {
      display: none;
      margin: 0 0 14px;
      padding: 9px 10px;
      border-radius: 8px;
      background: #fff4e5;
      color: #7a4100;
      border: 1px solid #ffd591;
    }
    .modal.sensitive .risk { display: block; }
    .modal button {
      all: unset;
      cursor: pointer;
      padding: 8px 14px;
      border-radius: 6px;
      font: inherit;
      font-weight: 500;
    }
    .modal .btn-once    { background: #e6efff; color: #0d47a1; }
    .modal .btn-always  { background: #0d47a1; color: #fff; }
    .modal .btn-deny    { background: #fbe9e7; color: #b71c1c; }
    .modal button:hover { filter: brightness(0.95); }
    @media (prefers-color-scheme: dark) {
      .modal { background: #1c1f24; color: #e8eaed; }
      .modal .host { background: #243049; color: #b8c8ff; }
      .modal .btn-once { background: #243049; color: #b8c8ff; }
      .modal .btn-deny { background: #3a1d1d; color: #ff8a80; }
      .modal .risk { background: #3a2a14; color: #ffd591; border-color: #6b4a18; }
    }
  `;

  const styleEl = document.createElement("style");
  styleEl.textContent = STYLE;
  shadow.appendChild(styleEl);

  // Status banner + viewport frame
  const frame = document.createElement("div");
  frame.className = "frame";
  shadow.appendChild(frame);

  const banner = document.createElement("div");
  banner.className = "banner";
  banner.innerHTML = `
    <span class="dot"></span>
    <span class="label" data-brand-template="{name} agent"></span>
    <span class="action">is controlling this tab</span>
    <button class="stop">Stop</button>
  `;
  shadow.appendChild(banner);
  brandRoot(banner);

  const actionLabel = banner.querySelector(".action");
  const stopBtn = banner.querySelector(".stop");
  stopBtn.addEventListener("click", () => {
    try {
      chrome.runtime.sendMessage({
        __jarela: true,
        type: "agent-overlay:stop-requested",
      });
    } catch {
      // SW gone; nothing more we can do.
    }
    hideBanner();
  });

  let activeCount = 0;
  let pendingHideTimer = null;
  // How long the banner lingers after the last action's `hide` arrives.
  // Agent runs are usually a chain of commands (navigate → click → fill
  // → extract …) and we briefly drop to 0 between each one. Without a
  // linger the banner flickers in/out the whole run, even though the
  // agent is still actively controlling the tab. Five seconds is enough
  // to bridge typical inter-command gaps without keeping the chrome
  // around long after the agent has actually stopped.
  const HIDE_LINGER_MS = 5000;

  function cancelPendingHide() {
    if (pendingHideTimer !== null) {
      clearTimeout(pendingHideTimer);
      pendingHideTimer = null;
    }
  }

  function showBanner(action) {
    cancelPendingHide();
    activeCount += 1;
    if (typeof action === "string" && action) {
      actionLabel.textContent = humanizeAction(action);
    }
    banner.classList.add("show");
    frame.classList.add("show");
  }
  function hideBanner() {
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount !== 0) return;
    cancelPendingHide();
    pendingHideTimer = setTimeout(() => {
      pendingHideTimer = null;
      if (activeCount === 0) {
        banner.classList.remove("show");
        frame.classList.remove("show");
      }
    }, HIDE_LINGER_MS);
  }

  function humanizeAction(action) {
    switch (action) {
      case "navigate":  return "is navigating this tab";
      case "click":     return "is clicking on this page";
      case "fill":      return "is typing into a field";
      case "fill_many": return "is filling multiple fields";
      case "scroll":    return "is scrolling this page";
      case "screenshot":return "is taking a screenshot";
      case "extract":   return "is reading from this page";
      default:          return "is controlling this tab";
    }
  }

  function approvalActionText(action) {
    switch (action) {
      case "navigate":   return "navigate this tab";
      case "click":      return "click on this page";
      case "fill":       return "type into a field";
      case "fill_many":  return "fill multiple fields";
      case "scroll":     return "scroll this page";
      case "screenshot": return "take a screenshot";
      case "extract":    return "read from this page";
      default:            return "control this tab";
    }
  }

  // Approval modal
  let modalEl = null;
  let pendingModal = null;
  function showApprovalModal({ host, action, requestId, details }) {
    if (pendingModal && pendingModal.requestId !== requestId) {
      // Replace the prior request — only one prompt at a time.
      respondTo(pendingModal.requestId, "deny");
      tearDownModal();
    }
    pendingModal = { requestId };

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const sensitive = details?.level === "sensitive";
    backdrop.innerHTML = `
      <div class="modal ${sensitive ? "sensitive" : ""}" role="dialog" aria-modal="true">
        <h2 data-brand-template="${sensitive ? "Review sensitive {name} browser action" : "Allow {name} agent to control this tab?"}"></h2>
        <p>The agent wants to <strong data-act></strong> on
          <span class="host" data-host></span>.</p>
        <p class="risk"><strong>Extra confirmation required.</strong> <span data-risk></span></p>
        <div class="actions">
          <button class="btn-deny"   data-choice="deny">Deny</button>
          <button class="btn-once"   data-choice="once">Approve once</button>
          <button class="btn-always" data-choice="always" ${sensitive ? "hidden" : ""}>Always allow on this site</button>
        </div>
      </div>
    `;
    brandRoot(backdrop);
    backdrop.querySelector("[data-host]").textContent = host;
    backdrop.querySelector("[data-act]").textContent = approvalActionText(action);
    const riskEl = backdrop.querySelector("[data-risk]");
    if (riskEl) {
      const reasons = Array.isArray(details?.reasons) ? details.reasons : [];
      riskEl.textContent = reasons.length > 0 ? reasons.join(", ") : "This action may expose private page data.";
    }
    backdrop.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      const choice = t.getAttribute("data-choice");
      if (!choice) return;
      respondTo(requestId, choice);
      tearDownModal();
    });
    shadow.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    modalEl = backdrop;
  }

  function tearDownModal() {
    if (modalEl?.parentNode) modalEl.parentNode.removeChild(modalEl);
    modalEl = null;
    pendingModal = null;
  }

  function respondTo(requestId, choice) {
    try {
      chrome.runtime.sendMessage({
        __jarela: true,
        type: "agent-overlay:approval-response",
        requestId,
        choice,
      });
    } catch {
      // Service worker may have been killed mid-prompt.
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__jarela !== true) return;
    if (msg.type === "agent-overlay:show") {
      showBanner(msg.action);
    } else if (msg.type === "agent-overlay:hide") {
      hideBanner();
    } else if (msg.type === "agent-overlay:request-approval") {
      showApprovalModal({
        host: String(msg.host || "this site"),
        action: msg.action,
        requestId: msg.requestId,
        details: msg.details || null,
      });
    } else if (msg.type === "agent-overlay:cancel-approval") {
      if (modalEl) {
        respondTo(pendingModal?.requestId, "deny");
        tearDownModal();
      }
    }
  });
})();
