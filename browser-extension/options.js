// Options page logic. Delegates all schema/URL building to lib/config.mjs
// so the same validation runs in the service worker and here.

import {
  STORAGE_KEY,
  SELECTED_AGENT_STORAGE_KEY,
  DEFAULT_CONFIG,
  parseConfig,
  isValidHost,
  isValidPort,
  isValidScheme,
  buildBase,
  buildOriginPatterns,
  matchesLaunchUrl,
  healthUrl,
  appUrl,
} from "./lib/config.mjs";
import { BRAND, applyBrand, mountUpstreamCredit } from "./lib/brand.mjs";

applyBrand();
mountUpstreamCredit(document.getElementById("upstream-credit"));

const HEALTH_TIMEOUT_MS = 2000;

const schemeEl = document.getElementById("scheme");
const hostEl = document.getElementById("host");
const portEl = document.getElementById("port");
const preferPwaEl = document.getElementById("preferPwa");
const autoOpenEl = document.getElementById("autoOpen");
const saveBtn = document.getElementById("save");
const testBtn = document.getElementById("test");
const openBtn = document.getElementById("open");
const formError = document.getElementById("formError");
const statusEl = document.querySelector(".status");
const statusLabel = statusEl.querySelector(".label");
const detailEl = document.getElementById("detail");

function setStatus(state, label, detail = "") {
  statusEl.dataset.state = state;
  statusLabel.textContent = label;
  detailEl.textContent = detail;
}

function setFormError(msg) {
  formError.textContent = msg || "";
}

function readForm() {
  return {
    scheme: schemeEl.value,
    host: hostEl.value.trim(),
    port: Number(portEl.value),
    preferPwa: preferPwaEl.checked,
    autoOpen: autoOpenEl.checked,
  };
}

function writeForm(cfg) {
  schemeEl.value = cfg.scheme;
  hostEl.value = cfg.host;
  portEl.value = String(cfg.port);
  preferPwaEl.checked = cfg.preferPwa;
  autoOpenEl.checked = cfg.autoOpen;
}

function validate(raw) {
  if (!isValidScheme(raw.scheme)) return "Scheme must be http or https.";
  if (!isValidHost(raw.host)) return "Host must be a hostname or IPv4 address (no slashes, ports, or paths).";
  if (!isValidPort(raw.port)) return "Port must be an integer between 1 and 65535.";
  return null;
}

async function loadStored() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return parseConfig(stored?.[STORAGE_KEY]);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function checkHealth(cfg) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(healthUrl(cfg), { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function ensureHostPermission(cfg) {
  const origins = buildOriginPatterns(cfg);
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

async function runTest(cfg) {
  setStatus("checking", "Checking…", `Probing ${buildBase(cfg)}`);
  const result = await checkHealth(cfg);
  if (result.ok) {
    setStatus("ok", "Connected", `${BRAND.name} responded at ${buildBase(cfg)}.`);
  } else if (result.status) {
    setStatus("err", "Unhealthy", `${buildBase(cfg)} responded with HTTP ${result.status}.`);
  } else {
    setStatus(
      "err",
      "Not reachable",
      `Could not reach ${buildBase(cfg)}. Is the ${BRAND.name} server running there?`,
    );
  }
  return result.ok;
}

async function getSelectedAgentId() {
  try {
    const stored = await chrome.storage.local.get(SELECTED_AGENT_STORAGE_KEY);
    const v = stored?.[SELECTED_AGENT_STORAGE_KEY];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  } catch {
    return null;
  }
}

// Open Jarela in the installed PWA window when possible, falling back to a
// regular tab. The PWA path needs `chrome.management` which is broad — we
// only request it the first time the user opts in to PWA mode.
async function openJarela(cfg) {
  const agentId = await getSelectedAgentId();
  if (cfg.preferPwa) {
    try {
      let granted = await chrome.permissions.contains({ permissions: ["management"] });
      if (!granted) {
        granted = await chrome.permissions.request({ permissions: ["management"] });
      }
      if (granted && chrome.management?.getAll) {
        const apps = await chrome.management.getAll();
        const match = apps.find((a) =>
          a.enabled &&
          (a.type === "hosted_app" || a.type === "packaged_app") &&
          matchesLaunchUrl(cfg, a.appLaunchUrl || a.homepageUrl || ""),
        );
        if (match) {
          await chrome.management.launchApp(match.id);
          return { launched: true, mode: "pwa" };
        }
      }
    } catch (err) {
      console.warn("[jarela] PWA launch failed, falling back to tab:", err);
    }
  }
  try {
    await chrome.tabs.create({ url: appUrl(cfg, { agentId }), active: true });
    return { launched: true, mode: "tab" };
  } catch (err) {
    console.warn("[jarela] tab open failed:", err);
    return { launched: false, mode: null };
  }
}

async function save() {
  setFormError("");
  const raw = readForm();
  const err = validate(raw);
  if (err) {
    setFormError(err);
    return;
  }
  const cfg = parseConfig(raw);
  saveBtn.disabled = true;
  testBtn.disabled = true;
  openBtn.disabled = true;
  try {
    const granted = await ensureHostPermission(cfg);
    if (!granted) {
      setFormError(
        `Permission denied for that origin. The extension needs host access to reach ${BRAND.name}.`,
      );
      return;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
    const ok = await runTest(cfg);
    if (ok && cfg.autoOpen) {
      await openJarela(cfg);
    }
  } finally {
    saveBtn.disabled = false;
    testBtn.disabled = false;
    openBtn.disabled = false;
  }
}

async function init() {
  const cfg = await loadStored();
  writeForm(cfg);
  await runTest(cfg);

  saveBtn.addEventListener("click", save);
  testBtn.addEventListener("click", () => {
    setFormError("");
    const raw = readForm();
    const err = validate(raw);
    if (err) {
      setFormError(err);
      return;
    }
    void runTest(parseConfig(raw));
  });
  openBtn.addEventListener("click", async () => {
    setFormError("");
    const raw = readForm();
    const err = validate(raw);
    if (err) {
      setFormError(err);
      return;
    }
    openBtn.disabled = true;
    try {
      await openJarela(parseConfig(raw));
    } finally {
      openBtn.disabled = false;
    }
  });

  for (const el of [schemeEl, hostEl, portEl]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void save();
      }
    });
  }
}

void init();
