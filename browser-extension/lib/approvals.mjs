// Per-host approval gate for agent-driven browser control.
//
// State machine (per origin, stored in chrome.storage.local):
//   undefined → "ask" the user (prompt)         — first time we see the host
//   "always"  → dispatch silently               — user opted in
//   "denied"  → reject every command            — user opted out
//
// Persisted under STORAGE_KEY as a flat { [hostname]: "always" | "denied" }
// map. We deliberately ignore the scheme/port — the user's mental model is
// "the site jarela.com", not "https://jarela.com:443/". Approval applies
// to all subpaths of the same hostname.
//
// All functions are pure: storage and prompt are injected so the gate is
// trivially unit-testable without chrome.* globals.

export const STORAGE_KEY = "jarelaBrowserApprovals";

export const APPROVAL_STATES = Object.freeze(["always", "denied"]);

function isValidState(s) { return s === "always" || s === "denied"; }

export function normalizeHost(host) {
  if (typeof host !== "string") return null;
  const h = host.trim().toLowerCase();
  if (!h) return null;
  // Strip any accidental scheme/path/port the caller may have passed.
  try {
    if (h.includes("://")) return new URL(h).hostname.toLowerCase();
  } catch {
    // Fall through: treat as a bare hostname.
  }
  return h.split("/")[0].split(":")[0];
}

export async function getAllApprovals(storage) {
  const raw = await storage.get(STORAGE_KEY);
  const map = raw?.[STORAGE_KEY];
  if (!map || typeof map !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const host = normalizeHost(k);
    if (host && isValidState(v)) out[host] = v;
  }
  return out;
}

export async function getApproval(storage, host) {
  const h = normalizeHost(host);
  if (!h) return undefined;
  const all = await getAllApprovals(storage);
  return all[h];
}

export async function setApproval(storage, host, state) {
  const h = normalizeHost(host);
  if (!h) throw new Error("approvals: invalid host");
  if (!isValidState(state)) throw new Error("approvals: invalid state");
  const all = await getAllApprovals(storage);
  all[h] = state;
  await storage.set({ [STORAGE_KEY]: all });
}

export async function clearApproval(storage, host) {
  const h = normalizeHost(host);
  if (!h) return;
  const all = await getAllApprovals(storage);
  if (!(h in all)) return;
  delete all[h];
  await storage.set({ [STORAGE_KEY]: all });
}

export async function syncApprovalsWithAllowedHosts(storage, hosts) {
  const allowed = new Set(
    (Array.isArray(hosts) ? hosts : [])
      .map((host) => normalizeHost(host))
      .filter(Boolean),
  );
  const all = await getAllApprovals(storage);
  let changed = false;
  for (const [host, state] of Object.entries(all)) {
    if (state === "always" && !allowed.has(host)) {
      delete all[host];
      changed = true;
    }
  }
  for (const host of allowed) {
    if (all[host] !== "always" && all[host] !== "denied") {
      all[host] = "always";
      changed = true;
    }
  }
  if (changed) await storage.set({ [STORAGE_KEY]: all });
  return all;
}

// Decide whether a command should be dispatched. `prompt` is called only
// when no persisted decision exists for the host and must resolve to one
// of "once" | "always" | "deny"; anything else is treated as a soft
// dismiss (the command is rejected without persisting a decision).
//
// Returns one of:
//   { allow: true }                              — dispatch the command
//   { allow: false, reason }                     — reject with reason
//   { allow: true, persisted: "always" }         — dispatch + remembered
//   { allow: false, reason, persisted: "denied" }— reject + remembered
export async function gateCommand({ storage, host, action, prompt, forcePrompt = false, promptDetails = null }) {
  const h = normalizeHost(host);
  if (!h) return { allow: false, reason: "no active tab origin" };
  const current = await getApproval(storage, h);
  if (current === "denied") {
    return { allow: false, reason: `agent control denied for ${h}` };
  }
  if (current === "always" && !forcePrompt) return { allow: true };
  let choice;
  try {
    choice = await prompt({ host: h, action, details: promptDetails, forcePrompt });
  } catch (err) {
    return { allow: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (choice === "always") {
    await setApproval(storage, h, "always");
    return { allow: true, persisted: "always" };
  }
  if (choice === "deny") {
    await setApproval(storage, h, "denied");
    return { allow: false, reason: `user denied agent control for ${h}`, persisted: "denied" };
  }
  if (choice === "once") return { allow: true };
  return { allow: false, reason: "user dismissed approval prompt" };
}
