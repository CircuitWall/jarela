import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-health-probes-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

const { saveIntegration, deleteIntegration } = await import("@/lib/stores/integrations");
const { storeOAuthToken, clearStoredOAuthToken } = await import("@/lib/providers/github-copilot-auth");
const {
  probeAtlassian, probeJiraAlign, probeGithub, probeGoogle, probeGmail,
  probeOutlook, probeICloud, probeAnthropic, probeOpenAI, probeDeepseek,
  probeCohere, probeGithubCopilot,
  listProbes, probeLabel, probeCategory, isIntegrationProbe, runProbe,
} = await import("./probes");

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(responder: FetchHandler): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => responder(input, init)));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function wipe(): void {
  for (const k of ["atlassian", "jira_align", "github", "google", "gmail", "outlook", "icloud", "anthropic", "openai", "deepseek", "cohere", "github-copilot"]) {
    deleteIntegration(k);
  }
  clearStoredOAuthToken();
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.COHERE_API_KEY;
  delete process.env.ATLASSIAN_URL;
  delete process.env.ATLASSIAN_EMAIL;
  delete process.env.ATLASSIAN_API_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.JIRA_ALIGN_URL;
  delete process.env.JIRA_ALIGN_TOKEN;
  delete process.env.OUTLOOK_CLIENT_ID;
  delete process.env.OUTLOOK_CLIENT_SECRET;
  delete process.env.OUTLOOK_REFRESH_TOKEN;
}

describe("health probes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    wipe();
  });

  // ── headline classification ──

  it("reports unconfigured when no credentials are saved", async () => {
    const r = await probeAtlassian();
    expect(r.ok).toBe(false);
    expect(r.status).toBe("unconfigured");
  });

  it("auth_failed maps 401 to a clear actionable message", async () => {
    saveIntegration("atlassian", { url: "https://example.atlassian.net", email: "a@b", api_token: "bad" });
    mockFetch(() => new Response("nope", { status: 401 }));
    const r = await probeAtlassian();
    expect(r.ok).toBe(false);
    expect(r.status).toBe("auth_failed");
    expect(String(r.error)).toMatch(/Regenerate|API token/i);
  });

  it("transient classifies network errors", async () => {
    saveIntegration("github", { token: "ghp_abc" });
    mockFetch(() => { throw new Error("ECONNRESET"); });
    const r = await probeGithub();
    expect(r.ok).toBe(false);
    expect(r.status).toBe("transient");
    expect(String(r.error)).toMatch(/ECONNRESET/);
  });

  it("ok on a 200 from the vendor", async () => {
    saveIntegration("anthropic", { api_key: "sk-ant-xxx" });
    mockFetch(() => jsonResponse({ data: [{ id: "claude-3-opus" }] }));
    const r = await probeAnthropic();
    expect(r.ok).toBe(true);
    expect(r.status).toBe("ok");
    expect(r.detail?.models).toBe(1);
  });

  it("429 is treated as transient (not auth) so the runner won't suggest regenerating the key", async () => {
    saveIntegration("anthropic", { api_key: "sk-ant-xxx" });
    mockFetch(() => new Response("rate limited", { status: 429 }));
    const r = await probeAnthropic();
    expect(r.ok).toBe(false);
    expect(r.status).toBe("transient");
  });

  // ── per-probe branch coverage ──

  describe("atlassian", () => {
    beforeEach(() => saveIntegration("atlassian", { url: "https://example.atlassian.net", email: "a@b", api_token: "ok" }));
    it("ok", async () => {
      mockFetch(() => jsonResponse({ displayName: "Andre", emailAddress: "a@b", accountId: "x" }));
      expect((await probeAtlassian()).status).toBe("ok");
    });
    it("403 is auth_failed", async () => {
      mockFetch(() => new Response("forbidden", { status: 403 }));
      expect((await probeAtlassian()).status).toBe("auth_failed");
    });
    it("429 transient", async () => {
      mockFetch(() => new Response("", { status: 429 }));
      expect((await probeAtlassian()).status).toBe("transient");
    });
    it("500 error", async () => {
      mockFetch(() => new Response("boom", { status: 500 }));
      expect((await probeAtlassian()).status).toBe("error");
    });
  });

  describe("jira_align", () => {
    it("unconfigured", async () => {
      expect((await probeJiraAlign()).status).toBe("unconfigured");
    });
    it("403 reads as ok with note (token authed but no read scope)", async () => {
      saveIntegration("jira_align", { url: "https://acme.jiraalign.com", api_token: "t" });
      mockFetch(() => new Response("forbidden", { status: 403 }));
      const r = await probeJiraAlign();
      expect(r.status).toBe("ok");
      expect(String(r.detail?.note)).toMatch(/no read access/i);
    });
    it("401 is auth_failed", async () => {
      saveIntegration("jira_align", { url: "https://acme.jiraalign.com", api_token: "t" });
      mockFetch(() => new Response("nope", { status: 401 }));
      expect((await probeJiraAlign()).status).toBe("auth_failed");
    });
    it("429 transient", async () => {
      saveIntegration("jira_align", { url: "https://acme.jiraalign.com", api_token: "t" });
      mockFetch(() => new Response("", { status: 429 }));
      expect((await probeJiraAlign()).status).toBe("transient");
    });
    it("ok", async () => {
      saveIntegration("jira_align", { url: "https://acme.jiraalign.com", api_token: "t" });
      mockFetch(() => jsonResponse({ items: [{ id: 1 }] }));
      const r = await probeJiraAlign();
      expect(r.status).toBe("ok");
      expect(r.detail?.sample_programs).toBe(1);
    });
    it("500 error", async () => {
      saveIntegration("jira_align", { url: "https://acme.jiraalign.com", api_token: "t" });
      mockFetch(() => new Response("boom", { status: 500 }));
      expect((await probeJiraAlign()).status).toBe("error");
    });
    it("network throw is transient", async () => {
      saveIntegration("jira_align", { url: "https://acme.jiraalign.com", api_token: "t" });
      mockFetch(() => { throw new Error("ETIMEDOUT"); });
      expect((await probeJiraAlign()).status).toBe("transient");
    });
  });

  describe("github", () => {
    it("unconfigured", async () => {
      expect((await probeGithub()).status).toBe("unconfigured");
    });
    it("ok", async () => {
      saveIntegration("github", { token: "ghp" });
      mockFetch(() => jsonResponse({ login: "andre", name: "Andre", type: "User" }));
      const r = await probeGithub();
      expect(r.status).toBe("ok");
      expect(r.detail?.login).toBe("andre");
    });
    it("403 auth_failed", async () => {
      saveIntegration("github", { token: "ghp" });
      mockFetch(() => new Response("", { status: 403 }));
      expect((await probeGithub()).status).toBe("auth_failed");
    });
    it("429 transient", async () => {
      saveIntegration("github", { token: "ghp" });
      mockFetch(() => new Response("", { status: 429 }));
      expect((await probeGithub()).status).toBe("transient");
    });
    it("500 error", async () => {
      saveIntegration("github", { token: "ghp" });
      mockFetch(() => new Response("boom", { status: 500 }));
      expect((await probeGithub()).status).toBe("error");
    });
  });

  describe("google", () => {
    it("unconfigured", async () => {
      expect((await probeGoogle()).status).toBe("unconfigured");
    });
    it("ok", async () => {
      saveIntegration("google", { api_key: "k" });
      mockFetch(() => jsonResponse({ models: [] }));
      expect((await probeGoogle()).status).toBe("ok");
    });
    it("400 auth_failed", async () => {
      saveIntegration("google", { api_key: "k" });
      mockFetch(() => new Response("invalid", { status: 400 }));
      expect((await probeGoogle()).status).toBe("auth_failed");
    });
    it("429 transient", async () => {
      saveIntegration("google", { api_key: "k" });
      mockFetch(() => new Response("", { status: 429 }));
      expect((await probeGoogle()).status).toBe("transient");
    });
    it("500 error", async () => {
      saveIntegration("google", { api_key: "k" });
      mockFetch(() => new Response("boom", { status: 500 }));
      expect((await probeGoogle()).status).toBe("error");
    });
    it("network throw is transient", async () => {
      saveIntegration("google", { api_key: "k" });
      mockFetch(() => { throw new Error("ECONNRESET"); });
      expect((await probeGoogle()).status).toBe("transient");
    });
  });

  describe("gmail", () => {
    function gmailCreds(): void {
      saveIntegration("gmail", { client_id: "cid", client_secret: "sec", refresh_token: "rt" });
    }
    it("unconfigured", async () => {
      expect((await probeGmail()).status).toBe("unconfigured");
    });
    it("refresh-token 400 is auth_failed", async () => {
      gmailCreds();
      mockFetch(() => new Response("invalid_grant", { status: 400 }));
      const r = await probeGmail();
      expect(r.status).toBe("auth_failed");
      expect(String(r.error)).toMatch(/OAuth setup|refresh token/i);
    });
    it("refresh-token 500 is error", async () => {
      gmailCreds();
      mockFetch(() => new Response("boom", { status: 500 }));
      expect((await probeGmail()).status).toBe("error");
    });
    it("missing access_token in token response is error", async () => {
      gmailCreds();
      mockFetch(() => jsonResponse({}));
      const r = await probeGmail();
      expect(r.status).toBe("error");
      expect(String(r.error)).toMatch(/access_token/);
    });
    it("ok end-to-end (token + labels both succeed)", async () => {
      gmailCreds();
      let calls = 0;
      mockFetch(() => {
        calls += 1;
        if (calls === 1) return jsonResponse({ access_token: "at" });
        return jsonResponse({ labels: [{ id: "1", name: "INBOX" }] });
      });
      const r = await probeGmail();
      expect(r.status).toBe("ok");
      expect(r.detail?.labels).toBe(1);
    });
    it("labels 401 is auth_failed", async () => {
      gmailCreds();
      let calls = 0;
      mockFetch(() => {
        calls += 1;
        if (calls === 1) return jsonResponse({ access_token: "at" });
        return new Response("nope", { status: 401 });
      });
      expect((await probeGmail()).status).toBe("auth_failed");
    });
    it("labels 429 is transient", async () => {
      gmailCreds();
      let calls = 0;
      mockFetch(() => {
        calls += 1;
        if (calls === 1) return jsonResponse({ access_token: "at" });
        return new Response("", { status: 429 });
      });
      expect((await probeGmail()).status).toBe("transient");
    });
    it("labels 500 is error", async () => {
      gmailCreds();
      let calls = 0;
      mockFetch(() => {
        calls += 1;
        if (calls === 1) return jsonResponse({ access_token: "at" });
        return new Response("boom", { status: 500 });
      });
      expect((await probeGmail()).status).toBe("error");
    });
    it("network throw is transient", async () => {
      gmailCreds();
      mockFetch(() => { throw new Error("ECONNRESET"); });
      expect((await probeGmail()).status).toBe("transient");
    });
  });

  describe("outlook", () => {
    function outlookCreds(): void {
      saveIntegration("outlook", { client_id: "cid", client_secret: "sec", refresh_token: "rt" });
    }
    it("unconfigured", async () => {
      expect((await probeOutlook()).status).toBe("unconfigured");
    });
    it("token refresh failure surfaces as auth_failed", async () => {
      outlookCreds();
      mockFetch(() => new Response("invalid_grant", { status: 400 }));
      const r = await probeOutlook();
      expect(r.status).toBe("auth_failed");
    });
    it("ok end-to-end", async () => {
      // Unique refresh_token per test so the in-process MS access-token cache
      // (keyed off refresh_token.slice(0, 20)) does not bleed across tests.
      saveIntegration("outlook", { client_id: "cid", client_secret: "sec", refresh_token: "rt-ok-aaaaaaaaaaaaaaaaa" });
      let calls = 0;
      mockFetch(() => {
        calls += 1;
        if (calls === 1) return jsonResponse({ access_token: "at", expires_in: 3600 });
        return jsonResponse({ displayName: "Andre", mail: "a@b" });
      });
      const r = await probeOutlook();
      expect(r.status).toBe("ok");
      expect(r.detail?.displayName).toBe("Andre");
    });
    it("graph 429 is transient", async () => {
      saveIntegration("outlook", { client_id: "cid", client_secret: "sec", refresh_token: "rt-429-bbbbbbbbbbbbbbbbb" });
      let calls = 0;
      mockFetch(() => {
        calls += 1;
        if (calls === 1) return jsonResponse({ access_token: "at2", expires_in: 3600 });
        return new Response("", { status: 429 });
      });
      expect((await probeOutlook()).status).toBe("transient");
    });
    it("graph 500 is error", async () => {
      saveIntegration("outlook", { client_id: "cid", client_secret: "sec", refresh_token: "rt-500-ccccccccccccccccc" });
      let calls = 0;
      mockFetch(() => {
        calls += 1;
        if (calls === 1) return jsonResponse({ access_token: "at3", expires_in: 3600 });
        return new Response("boom", { status: 500 });
      });
      expect((await probeOutlook()).status).toBe("error");
    });
  });

  describe("icloud", () => {
    function icloudCreds(): void {
      saveIntegration("icloud", { apple_id: "jappleseed@icloud.com", app_password: "abcd-efgh-ijkl-mnop" });
    }
    it("unconfigured", async () => {
      expect((await probeICloud()).status).toBe("unconfigured");
    });
    it("ok on 207 Multi-Status", async () => {
      icloudCreds();
      mockFetch(() => new Response("<d:multistatus xmlns:d=\"DAV:\"/>", { status: 207 }));
      const r = await probeICloud();
      expect(r.status).toBe("ok");
    });
    it("401 auth_failed", async () => {
      icloudCreds();
      mockFetch(() => new Response("", { status: 401 }));
      expect((await probeICloud()).status).toBe("auth_failed");
    });
    it("429 transient", async () => {
      icloudCreds();
      mockFetch(() => new Response("", { status: 429 }));
      expect((await probeICloud()).status).toBe("transient");
    });
    it("500 error", async () => {
      icloudCreds();
      mockFetch(() => new Response("boom", { status: 500 }));
      expect((await probeICloud()).status).toBe("error");
    });
    it("network throw transient", async () => {
      icloudCreds();
      mockFetch(() => { throw new Error("ECONNRESET"); });
      expect((await probeICloud()).status).toBe("transient");
    });
    it("strips dashes and whitespace from app_password before basic auth", async () => {
      saveIntegration("icloud", { apple_id: "jappleseed@icloud.com", app_password: "abcd-efgh-ijkl-mnop" });
      let authHeader = "";
      mockFetch((_input, init) => {
        authHeader = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
        return new Response("", { status: 207 });
      });
      await probeICloud();
      const expected = "Basic " + Buffer.from("jappleseed@icloud.com:abcdefghijklmnop").toString("base64");
      expect(authHeader).toBe(expected);
    });
  });

  describe("anthropic", () => {
    beforeEach(() => saveIntegration("anthropic", { api_key: "k" }));
    it("403 auth_failed", async () => {
      mockFetch(() => new Response("", { status: 403 }));
      expect((await probeAnthropic()).status).toBe("auth_failed");
    });
    it("500 error", async () => {
      mockFetch(() => new Response("", { status: 500 }));
      expect((await probeAnthropic()).status).toBe("error");
    });
    it("network throw transient", async () => {
      mockFetch(() => { throw new Error("ECONNRESET"); });
      expect((await probeAnthropic()).status).toBe("transient");
    });
  });

  describe("openai", () => {
    it("unconfigured", async () => {
      expect((await probeOpenAI()).status).toBe("unconfigured");
    });
    it("reads from the integration store first", async () => {
      saveIntegration("openai", { api_key: "sk-store" });
      mockFetch(() => jsonResponse({ data: [{ id: "gpt-4o" }] }));
      expect((await probeOpenAI()).status).toBe("ok");
    });
    it("falls back to OPENAI_API_KEY env var", async () => {
      process.env.OPENAI_API_KEY = "sk-env";
      mockFetch(() => jsonResponse({ data: [{ id: "gpt-4o" }] }));
      expect((await probeOpenAI()).status).toBe("ok");
    });
    it("401 auth_failed", async () => {
      process.env.OPENAI_API_KEY = "sk-x";
      mockFetch(() => new Response("", { status: 401 }));
      expect((await probeOpenAI()).status).toBe("auth_failed");
    });
    it("429 transient", async () => {
      process.env.OPENAI_API_KEY = "sk-x";
      mockFetch(() => new Response("", { status: 429 }));
      expect((await probeOpenAI()).status).toBe("transient");
    });
    it("500 error", async () => {
      process.env.OPENAI_API_KEY = "sk-x";
      mockFetch(() => new Response("", { status: 500 }));
      expect((await probeOpenAI()).status).toBe("error");
    });
    it("ok", async () => {
      process.env.OPENAI_API_KEY = "sk-x";
      mockFetch(() => jsonResponse({ data: [{ id: "gpt-4" }, { id: "gpt-4o" }] }));
      const r = await probeOpenAI();
      expect(r.status).toBe("ok");
      expect(r.detail?.models).toBe(2);
    });
    it("network throw transient", async () => {
      process.env.OPENAI_API_KEY = "sk-x";
      mockFetch(() => { throw new Error("ECONNRESET"); });
      expect((await probeOpenAI()).status).toBe("transient");
    });
  });

  describe("deepseek", () => {
    it("unconfigured", async () => {
      expect((await probeDeepseek()).status).toBe("unconfigured");
    });
    it("reads from the integration store first", async () => {
      saveIntegration("deepseek", { api_key: "sk-store" });
      mockFetch(() => jsonResponse({ data: [{ id: "deepseek-chat" }] }));
      expect((await probeDeepseek()).status).toBe("ok");
    });
    it("falls back to DEEPSEEK_API_KEY env var", async () => {
      process.env.DEEPSEEK_API_KEY = "sk-env";
      mockFetch(() => jsonResponse({ data: [{ id: "deepseek-chat" }] }));
      expect((await probeDeepseek()).status).toBe("ok");
    });
    it("401 auth_failed", async () => {
      process.env.DEEPSEEK_API_KEY = "ds";
      mockFetch(() => new Response("", { status: 401 }));
      expect((await probeDeepseek()).status).toBe("auth_failed");
    });
    it("429 transient", async () => {
      process.env.DEEPSEEK_API_KEY = "ds";
      mockFetch(() => new Response("", { status: 429 }));
      expect((await probeDeepseek()).status).toBe("transient");
    });
    it("500 error", async () => {
      process.env.DEEPSEEK_API_KEY = "ds";
      mockFetch(() => new Response("", { status: 500 }));
      expect((await probeDeepseek()).status).toBe("error");
    });
    it("ok", async () => {
      process.env.DEEPSEEK_API_KEY = "ds";
      mockFetch(() => jsonResponse({ data: [{ id: "deepseek-chat" }] }));
      expect((await probeDeepseek()).status).toBe("ok");
    });
    it("network throw transient", async () => {
      process.env.DEEPSEEK_API_KEY = "ds";
      mockFetch(() => { throw new Error("ECONNRESET"); });
      expect((await probeDeepseek()).status).toBe("transient");
    });
  });

  describe("cohere", () => {
    it("unconfigured", async () => {
      expect((await probeCohere()).status).toBe("unconfigured");
    });
    it("reads from the integration store first", async () => {
      saveIntegration("cohere", { api_key: "co-store" });
      mockFetch(() => jsonResponse({ models: [{ name: "command-r" }] }));
      const r = await probeCohere();
      expect(r.status).toBe("ok");
      expect(r.detail?.models).toBe(1);
    });
    it("falls back to COHERE_API_KEY env var", async () => {
      process.env.COHERE_API_KEY = "co-env";
      mockFetch(() => jsonResponse({ models: [] }));
      expect((await probeCohere()).status).toBe("ok");
    });
    it("401 auth_failed", async () => {
      process.env.COHERE_API_KEY = "co";
      mockFetch(() => new Response("", { status: 401 }));
      expect((await probeCohere()).status).toBe("auth_failed");
    });
    it("429 transient", async () => {
      process.env.COHERE_API_KEY = "co";
      mockFetch(() => new Response("", { status: 429 }));
      expect((await probeCohere()).status).toBe("transient");
    });
    it("network throw transient", async () => {
      process.env.COHERE_API_KEY = "co";
      mockFetch(() => { throw new Error("ECONNRESET"); });
      expect((await probeCohere()).status).toBe("transient");
    });
  });

  describe("github-copilot", () => {
    it("unconfigured when no oauth token and no PAT", async () => {
      expect((await probeGithubCopilot()).status).toBe("unconfigured");
    });
    it("oauth token: ok exchanges for session token", async () => {
      storeOAuthToken("gho_xxx");
      mockFetch(() => jsonResponse({ token: "tok-abc", expires_at: "2030-01-01T00:00:00Z" }));
      const r = await probeGithubCopilot();
      expect(r.status).toBe("ok");
      expect(r.detail?.auth).toBe("oauth");
    });
    it("oauth token: 401 auth_failed", async () => {
      storeOAuthToken("gho_bad");
      mockFetch(() => new Response("", { status: 401 }));
      expect((await probeGithubCopilot()).status).toBe("auth_failed");
    });
    it("oauth token: 404 surfaces missing subscription", async () => {
      storeOAuthToken("gho_xxx");
      mockFetch(() => new Response("", { status: 404 }));
      const r = await probeGithubCopilot();
      expect(r.status).toBe("auth_failed");
      expect(String(r.error)).toMatch(/subscription/i);
    });
    it("PAT fallback: ok against the Models API", async () => {
      saveIntegration("github-copilot", { api_key: "ghp_xxx" });
      mockFetch(() => jsonResponse({ models: [] }));
      const r = await probeGithubCopilot();
      expect(r.status).toBe("ok");
      expect(r.detail?.auth).toBe("pat");
    });
    it("PAT fallback: 401 auth_failed", async () => {
      saveIntegration("github-copilot", { api_key: "ghp_bad" });
      mockFetch(() => new Response("", { status: 401 }));
      expect((await probeGithubCopilot()).status).toBe("auth_failed");
    });
    it("prefers OAuth token over PAT when both are present", async () => {
      storeOAuthToken("gho_xxx");
      saveIntegration("github-copilot", { api_key: "ghp_xxx" });
      let firstUrl: string | null = null;
      mockFetch((input) => {
        firstUrl = typeof input === "string" ? input : input.toString();
        return jsonResponse({ token: "sess", expires_at: "2030-01-01T00:00:00Z" });
      });
      await probeGithubCopilot();
      expect(firstUrl).toContain("/copilot_internal/v2/token");
    });
    it("network throw transient", async () => {
      storeOAuthToken("gho_xxx");
      mockFetch(() => { throw new Error("ECONNRESET"); });
      expect((await probeGithubCopilot()).status).toBe("transient");
    });
  });

  describe("registry helpers", () => {
    it("lists every probe with a label and category", () => {
      const names = listProbes();
      expect(names.length).toBe(12);
      for (const n of names) {
        expect(typeof probeLabel(n)).toBe("string");
        expect(["integration", "llm"]).toContain(probeCategory(n));
      }
    });
    it("isIntegrationProbe is true for known integration names", () => {
      expect(isIntegrationProbe("github")).toBe(true);
      expect(isIntegrationProbe("atlassian")).toBe(true);
      expect(isIntegrationProbe("cohere")).toBe(true);
      expect(isIntegrationProbe("github-copilot")).toBe(true);
      expect(isIntegrationProbe("nonsense")).toBe(false);
    });
    it("runProbe dispatches by name", async () => {
      const r = await runProbe("github");
      expect(r.status).toBe("unconfigured");
    });
  });
});
