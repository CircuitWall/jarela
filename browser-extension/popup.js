function getAgentSelect() {
  return document.getElementById("agent");
}

function currentAgentId() {
  const sel = getAgentSelect();
  const v = String(sel?.value ?? "").trim();
  return v.length > 0 ? v : null;
}

function initials(name) {
  const txt = String(name || "AI").trim();
  if (!txt) return "AI";
  const parts = txt.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function setStatus(text, kind = "") {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

async function callBackground(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

function renderAgentAvatar(agent) {
  const img = document.getElementById("agent-avatar-img");
  const fallback = document.getElementById("agent-avatar-fallback");
  const rawIcon = typeof agent?.icon === "string" ? agent.icon.trim() : "";
  // bundle:* literals are toolbar-icon hints, not real image URLs — they
  // would 404 silently as <img src> and leave the avatar blank. Treat them
  // (and anything else that's clearly not a URL / data URL) as "no icon"
  // so the initials fallback renders.
  const isLoadable =
    rawIcon.length > 0 &&
    !rawIcon.toLowerCase().startsWith("bundle:") &&
    (rawIcon.startsWith("data:") || rawIcon.startsWith("http://") || rawIcon.startsWith("https://") || rawIcon.startsWith("/"));

  function showFallback() {
    img.style.display = "none";
    img.removeAttribute("src");
    fallback.textContent = initials(agent?.name ?? "AI");
    fallback.style.display = "inline";
  }

  if (!isLoadable) {
    showFallback();
    return;
  }

  img.onerror = () => { showFallback(); };
  img.onload = () => {
    img.style.display = "block";
    fallback.style.display = "none";
  };
  img.src = rawIcon;
}

async function loadAgents() {
  const sel = getAgentSelect();
  if (!sel) return;

  sel.innerHTML = "";
  const loading = document.createElement("option");
  loading.value = "";
  loading.textContent = "Loading agents...";
  sel.appendChild(loading);

  const [listRes, savedRes] = await Promise.all([
    callBackground("jarela-list-agents"),
    callBackground("jarela-get-agent"),
  ]);

  if (!listRes?.ok) {
    sel.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No agents available";
    sel.appendChild(opt);
    setStatus(`Could not load agents: ${listRes?.body?.error ?? "unknown error"}`, "err");
    renderAgentAvatar(null);
    return;
  }

  const agents = Array.isArray(listRes?.body?.agents) ? listRes.body.agents : [];
  const savedAgentId = typeof savedRes?.body?.agent_id === "string" ? savedRes.body.agent_id : "";
  const defaultAgentId = typeof listRes?.body?.default_agent_id === "string" ? listRes.body.default_agent_id : "";

  sel.innerHTML = "";
  for (const a of agents) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.is_default ? `${a.name} (default)` : a.name;
    sel.appendChild(opt);
  }

  if (agents.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No agents available";
    sel.appendChild(opt);
    renderAgentAvatar(null);
    return;
  }

  const target = savedAgentId || defaultAgentId || agents[0].id;
  sel.value = agents.some((a) => a.id === target) ? target : agents[0].id;
  renderAgentAvatar(agents.find((a) => a.id === sel.value) ?? agents[0]);
  await callBackground("jarela-set-agent", { agent_id: sel.value });

  sel.addEventListener("change", async () => {
    const picked = agents.find((a) => a.id === currentAgentId()) ?? null;
    renderAgentAvatar(picked);
    await callBackground("jarela-set-agent", { agent_id: currentAgentId() });
  });
}

document.getElementById("pick").addEventListener("click", async () => {
  setStatus("Starting picker…");
  const res = await callBackground("jarela-start-picker");
  if (res?.ok) {
    setStatus("Picker started in active tab.", "ok");
    window.close();
  } else {
    setStatus(`Picker failed: ${res?.body?.error ?? "unknown error"}`, "err");
  }
});

// Pre-fetched window/tab ids so the side-panel click handler can call
// chrome.sidePanel.open() synchronously inside its user gesture.
let cachedWindowId = null;
let cachedTabId = null;

async function primeSidePanelContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId !== undefined) cachedWindowId = tab.windowId;
    if (tab?.id !== undefined) cachedTabId = tab.id;
    if (cachedTabId !== null) {
      try {
        await chrome.sidePanel.setOptions({ tabId: cachedTabId, path: "panel.html", enabled: true });
      } catch {
        // non-fatal; open() will surface a real error if anything is wrong
      }
    }
  } catch {
    // ignore; click handler will report a clear error
  }
}

document.getElementById("open-jarela").addEventListener("click", (event) => {
  // chrome.sidePanel.open() requires a user gesture AND must be invoked
  // synchronously — any await before it loses the gesture. We use the
  // pre-fetched windowId/tabId so no async work runs first.
  setStatus("Opening Jarela…");
  if (cachedWindowId === null && cachedTabId === null) {
    setStatus("Could not open Jarela: no active window yet, try again.", "err");
    return;
  }
  let openPromise;
  try {
    const opts = cachedWindowId !== null ? { windowId: cachedWindowId } : { tabId: cachedTabId };
    openPromise = chrome.sidePanel.open(opts);
  } catch (err) {
    setStatus(`Could not open Jarela: ${err?.message ?? String(err)}`, "err");
    return;
  }

  Promise.resolve(openPromise)
    .then(() => {
      setStatus("Opened Jarela.", "ok");
      window.close();
    })
    .catch((err) => {
      setStatus(`Could not open Jarela: ${err?.message ?? String(err)}`, "err");
    });
});

void loadAgents();
void primeSidePanelContext();
