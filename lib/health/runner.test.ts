import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-health-runner-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

const { saveIntegration, deleteIntegration } = await import("@/lib/stores/integrations");
const { subscribe } = await import("@/lib/notifications/bus");
const { runAllHealthProbes, getHealthSnapshot, _resetHealthRunner } = await import("./runner");

interface CapturedAlert {
  probe: string;
  status: string;
  error: string | null;
  ts: number;
}

function captureAlerts(): { alerts: CapturedAlert[]; unsubscribe: () => void } {
  const alerts: CapturedAlert[] = [];
  const unsubscribe = subscribe((ev) => {
    if (ev.type !== "health_alert") return;
    alerts.push({ probe: ev.probe, status: ev.status, error: ev.error, ts: ev.ts });
  });
  return { alerts, unsubscribe };
}

function stubFetchByHost(handler: (host: string) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    const host = new URL(url).hostname;
    return handler(host);
  }));
}

describe("health runner", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetHealthRunner();
    // Wipe every integration so unconfigured probes are silent and we
    // can opt into one at a time.
    for (const k of ["atlassian", "github", "google", "gmail", "outlook", "anthropic", "jira_align"]) {
      deleteIntegration(k);
    }
    // Several integrations have env-var fallbacks that bypass the
    // `integrations` namespace (`_resolveGithubAuth` reads GITHUB_TOKEN /
    // GH_TOKEN before falling back to the store; Atlassian and Jira Align
    // do the same with their respective vars). The test runs in whatever
    // shell the developer happens to have, which often has GITHUB_TOKEN
    // set for the gh CLI — leaving an "unconfigured" assertion silently
    // false. Clear them all here so each case opts in by setting only what
    // it needs.
    for (const v of [
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "ATLASSIAN_URL",
      "ATLASSIAN_EMAIL",
      "ATLASSIAN_API_TOKEN",
      "JIRA_ALIGN_URL",
      "JIRA_ALIGN_TOKEN",
      "GMAIL_CLIENT_ID",
      "GMAIL_CLIENT_SECRET",
      "GMAIL_REFRESH_TOKEN",
    ]) {
      delete process.env[v];
    }
  });

  it("publishes a single alert on first failure (not one per cycle)", async () => {
    saveIntegration("anthropic", { api_key: "sk-ant-xxx" });
    stubFetchByHost(() => new Response("nope", { status: 401 }));
    const { alerts, unsubscribe } = captureAlerts();
    try {
      await runAllHealthProbes(1_000);
      await runAllHealthProbes(2_000);
      await runAllHealthProbes(3_000);
      const anthropicAlerts = alerts.filter((a) => a.probe === "anthropic");
      expect(anthropicAlerts.length).toBe(1);
      expect(anthropicAlerts[0].status).toBe("auth_failed");
    } finally {
      unsubscribe();
    }
  });

  it("re-fires after 30 min of continuous failure", async () => {
    saveIntegration("anthropic", { api_key: "sk-ant-xxx" });
    stubFetchByHost(() => new Response("nope", { status: 401 }));
    const { alerts, unsubscribe } = captureAlerts();
    try {
      await runAllHealthProbes(1_000);
      await runAllHealthProbes(1_000 + 10 * 60 * 1000); // 10 min later, still failing
      await runAllHealthProbes(1_000 + 31 * 60 * 1000); // 31 min later
      const anthropicAlerts = alerts.filter((a) => a.probe === "anthropic");
      expect(anthropicAlerts.length).toBe(2);
    } finally {
      unsubscribe();
    }
  });

  it("publishes a recovery alert when a failing probe goes green", async () => {
    saveIntegration("anthropic", { api_key: "sk-ant-xxx" });
    let healthy = false;
    stubFetchByHost(() => healthy
      ? new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("nope", { status: 401 }));
    const { alerts, unsubscribe } = captureAlerts();
    try {
      await runAllHealthProbes(1_000);
      healthy = true;
      await runAllHealthProbes(2_000);
      const anthropicAlerts = alerts.filter((a) => a.probe === "anthropic");
      expect(anthropicAlerts.map((a) => a.status)).toEqual(["auth_failed", "recovered"]);
    } finally {
      unsubscribe();
    }
  });

  it("never alerts for unconfigured probes", async () => {
    // Nothing configured.
    stubFetchByHost(() => new Response("should not be called", { status: 500 }));
    const { alerts, unsubscribe } = captureAlerts();
    try {
      await runAllHealthProbes(1_000);
      expect(alerts.length).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it("getHealthSnapshot includes every registered probe with never_checked when not run", async () => {
    const snap = getHealthSnapshot();
    expect(snap.probes.length).toBeGreaterThan(0);
    for (const p of snap.probes) {
      expect(p.status).toBe("never_checked");
    }
  });
});
