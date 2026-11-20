/**
 * Ask-once host access for the browser tools.
 *
 * The extension only holds static host permissions for the Jarela server;
 * every other origin needs the user to grant it (`chrome.permissions.request`
 * needs a gesture, so the agent cannot do it itself). Without this tool the
 * agent saw a generic failure, retried, and eventually stopped with a retry
 * notice — it never asked.
 *
 * The decision is stored in `allowed_sites`, which the Settings → Allowed
 * sites panel already lists and revokes, and which the extension caches for
 * cookie passthrough. One place to manage the answer.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getExtensionStatus } from "@/lib/api/browser-control";
import { isHostAllowed } from "@/lib/stores/allowed-sites";
import { registerLangChainPackage } from "../packages/langchain-package";

// The layer Jarela cannot verify: Chrome/Edge only exposes a host grant to the
// extension, so the server reports the manual check instead of guessing. The
// extension should report `chrome.permissions.getAll()` on its poll so this
// layer becomes a boolean too (follow-up; the contract is fixed here so the
// result shape does not change when it lands).
const BROWSER_GRANT_LAYER = {
  ok: null,
  blocker: "browser_host_grant_unverified",
  fix:
    "Jarela cannot see the browser's own host grant. Before the first action on a new host, ask the user to check " +
    "edge://extensions → Jarela → Details → Site access and set it to \"On all sites\" (chrome://extensions in Chrome, " +
    "and the extension popup for other browsers). Per-site prompts are what leave the worker suspended.",
};

function hostnameOf(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export const browserPermissionTool = tool(
  async ({ url }) => {
    const hostname = hostnameOf(url);
    if (!hostname) {
      return JSON.stringify({ allowed: false, error: "provide a URL or hostname, e.g. https://example.com/path" });
    }

    // Preflight is per layer, because each layer has a different owner and a
    // different fix. Reporting a single boolean is what let the agent navigate
    // first and discover the block a timeout later.
    const status = getExtensionStatus();
    const channel = status.connected
      ? { ok: true }
      : {
          ok: false,
          blocker: "extension_offline",
          fix:
            "The Jarela extension has not polled the server recently. Ask the user to open the browser, click the Jarela " +
            "toolbar icon to wake it, and confirm it shows connected. Do not start a browser step until it does.",
        };
    const match = isHostAllowed(hostname);
    const jarela: Record<string, unknown> = match.allowed
      ? { ok: true, rule: match.matchedHostname === hostname ? "exact" : "suffix" }
      : {
          ok: false,
          blocker: "jarela_site_not_allowed",
          fix:
            `Ask the user once with propose_config_change({ kind: "allow_site", payload: { hostname: "${hostname}" }, ` +
            "reason: \"...\" }) and say in the reason that approving lets the agent drive a tab on this host and share " +
            "its cookies with web_fetch. The answer is saved in Settings → Allowed sites, where it can be reviewed or revoked.",
        };

    const ready = status.connected && match.allowed;
    const blockers = [channel, jarela].filter((l) => !("ok" in l) || l.ok === false).map((l) => String((l as { blocker?: string }).blocker));
    return JSON.stringify({
      hostname: match.matchedHostname || hostname,
      ready,
      blockers,
      layers: { channel, jarela_site: jarela, browser_host_grant: BROWSER_GRANT_LAYER },
      ...(ready
        ? {}
        : {
            ask_user: true,
            next_step:
              "Do not start or retry the browser step yet. Resolve the listed blockers in order: the user has to act on " +
              "each one, and the ask-user instruction for it is in this result.",
          }),
    });
  },
  {
    name: "browser_permission",
    description:
      "Preflight every layer that can block a browser step, for one host: the extension channel, Jarela's Allowed sites " +
      "list, and the browser's own host grant. " +
      "Call this before the first browser action on a host and whenever a browser result returns an error_code — one of " +
      "extension_offline, jarela_site_not_allowed or browser_host_grant_unverified. " +
      "Read-only: it never grants anything itself, and each blocker carries the exact ask-user instruction.",
    schema: z.object({
      url: z.string().min(1).describe("URL or hostname the agent needs, e.g. 'https://example.com/inbox' or 'example.com'"),
    }),
  },
);

registerLangChainPackage({ category: "Web", tools: { read: [browserPermissionTool] } });
