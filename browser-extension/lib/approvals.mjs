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
// The prompt exists to catch action the user cannot SEE. When the command
// targets the tab they are looking at, the on-page overlay already narrates
// every step and the Stop button is one click away, so a modal adds friction
// without adding information. Approval is therefore reserved for work on
// tabs that are out of view — see `decideGate` and ADR-0083.
//
// This map is local and authoritative. It is deliberately NOT reconciled
// against the server's allowed-sites list: that list governs cookie
// passthrough, which is a different and much stronger grant.
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

/**
 * The whole approval policy, in one pure function.
 *
 *   denied            → always reject, focused or not.
 *   target is focused → allow; the user is watching and can hit Stop.
 *   always            → allow.
 *   otherwise         → prompt.
 */
export function decideGate({ approval, targetFocused }) {
  if (approval === "denied") return "deny";
  if (targetFocused) return "allow";
  if (approval === "always") return "allow";
  return "prompt";
}

// Decide whether a command should be dispatched. `prompt` is called only
// when `decideGate` asks for it and must resolve to one of
// "once" | "always" | "deny"; anything else is treated as a soft dismiss
// (the command is rejected without persisting a decision).
//
// Returns one of:
//   { allow: true }                              — dispatch the command
//   { allow: false, reason }                     — reject with reason
//   { allow: true, persisted: "always" }         — dispatch + remembered
//   { allow: false, reason, persisted: "denied" }— reject + remembered
export async function gateCommand({ storage, host, action, prompt, targetFocused = false, promptDetails = null }) {
  const h = normalizeHost(host);
  if (!h) return { allow: false, reason: "no active tab origin" };
  const current = await getApproval(storage, h);
  const decision = decideGate({ approval: current, targetFocused });
  if (decision === "deny") {
    return { allow: false, reason: `agent control denied for ${h}` };
  }
  if (decision === "allow") return { allow: true };
  let choice;
  try {
    choice = await prompt({ host: h, action, details: promptDetails, targetFocused });
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
