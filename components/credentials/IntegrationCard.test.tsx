// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { IntegrationCard } from "./IntegrationCard";
import { api } from "@/api/client";
import type { Credential, IntegrationDefinition, IntegrationStatus } from "@/api/types";
import * as confirmation from "@/lib/ui/confirm";

const claudeCodeDefinition: IntegrationDefinition = {
  name: "claude-code",
  label: "Claude Code",
  category: "infrastructure",
  description: "Used by claude_delegate.",
  fields: [
    { key: "cli_path", label: "CLI path (optional)", placeholder: "/opt/homebrew/bin/claude", secret: false, required: false },
    { key: "api_key", label: "Anthropic API key (optional)", placeholder: "sk-ant-...", secret: true, required: false },
    { key: "auth_token", label: "Anthropic auth token (optional)", placeholder: "auth_...", secret: true, required: false },
    { key: "base_url", label: "Anthropic base URL (optional)", placeholder: "https://api.anthropic.com", secret: false, required: false },
    { key: "default_opus_model", label: "Default Opus model (optional)", placeholder: "claude-opus-4-1", secret: false, required: false },
    { key: "default_sonnet_model", label: "Default Sonnet model (optional)", placeholder: "claude-sonnet-4-5", secret: false, required: false },
    { key: "default_haiku_model", label: "Default Haiku model (optional)", placeholder: "claude-haiku-4-5", secret: false, required: false },
    { key: "default_model", label: "Default delegate model (optional)", placeholder: "sonnet", secret: false, required: false },
    { key: "default_tools", label: "Default Claude tools (optional)", placeholder: "default", secret: false, required: false },
    { key: "default_add_dirs", label: "Extra directories (optional)", placeholder: "/path/one, /path/two", secret: false, required: false },
    { key: "default_permission_mode", label: "Permission mode (optional)", placeholder: "dontAsk", secret: false, required: false },
    { key: "default_allow_unsafe", label: "Allow unsafe by default (optional)", placeholder: "false", secret: false, required: false },
    { key: "default_background", label: "Run in background by default (optional)", placeholder: "false", secret: false, required: false },
    { key: "default_timeout_seconds", label: "Timeout seconds (optional)", placeholder: "600", secret: false, required: false },
    { key: "default_sync_memory", label: "Memory sync mode (optional)", placeholder: "both", secret: false, required: false },
    { key: "default_escalate_questions", label: "Ask design questions by default (optional)", placeholder: "true", secret: false, required: false },
  ],
};

describe("IntegrationCard", () => {
  it("groups Claude connection fields separately from launch defaults", () => {
    render(
      <IntegrationCard
        definition={claudeCodeDefinition}
        status={{
          name: "claude-code",
          configured: true,
          values: {
            cli_path: "/opt/homebrew/bin/claude",
            default_model: "sonnet",
            default_background: "true",
          },
          updated_at: "2026-08-25T00:00:00.000Z",
        }}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Connection").some((el) => el.tagName === "DIV")).toBe(true);
    expect(screen.getAllByText("Launch defaults").some((el) => el.tagName === "DIV")).toBe(true);
    expect(screen.getByText(/These defaults apply whenever an agent calls/)).toBeTruthy();
    expect(screen.getByLabelText(/CLI path/)).toHaveProperty("value", "/opt/homebrew/bin/claude");
    expect(screen.getByLabelText(/Default delegate model/)).toHaveProperty("value", "sonnet");
    expect(screen.getByLabelText(/Run in background by default/)).toHaveProperty("value", "true");
  });

  function mailDefinition(provider: "gmail" | "outlook"): IntegrationDefinition {
    return {
      name: provider,
      label: provider === "gmail" ? "Gmail" : "Outlook",
      description: "Synthetic mail integration",
      fields: [
        { key: "client_id", label: "Client ID", secret: false, required: false },
        { key: "client_secret", label: "Client secret", secret: true, required: false },
        { key: "refresh_token", label: "Refresh token", secret: true, required: false },
      ],
    };
  }

  function mailCredential(provider: "gmail" | "outlook"): Credential {
    return {
      id: `integration-${provider}-work`,
      type: "integration",
      provider,
      auth_method: "oauth",
      label: "Work",
      is_default: false,
      params: { client_id: "synthetic-client", client_secret: "***", refresh_token: "***" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
  }

  describe("IntegrationCard OAuth and credential contracts", () => {
    const onChanged = vi.fn();
    const closePopup = vi.fn();
    const startResult = {
      authorize_url: "https://example.com/authorize",
      state: "synthetic-state",
      redirect_uri: "http://localhost/callback",
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(window, "open").mockReturnValue(window);
      vi.spyOn(window, "close").mockImplementation(closePopup);
      vi.spyOn(api.integrations, "gmailOauthStart").mockResolvedValue(startResult);
      vi.spyOn(api.integrations, "outlookOauthStart").mockResolvedValue(startResult);
      vi.spyOn(api.integrations, "gmailOauthStatus").mockResolvedValue({ status: "pending" });
      vi.spyOn(api.integrations, "outlookOauthStatus").mockResolvedValue({ status: "pending" });
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.clearAllMocks();
    });

    async function connect(provider: "gmail" | "outlook" = "gmail") {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: provider === "gmail" ? "Connect Gmail" : "Connect Outlook" }));
      });
    }

    async function poll(ms = 1500) {
      await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    }

    it("uses the bundled Gmail client when no app credentials are entered", async () => {
      render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      expect(api.integrations.gmailOauthStart).toHaveBeenCalledWith({
        client_id: undefined, client_secret: undefined, credential_id: undefined,
      });
      expect(window.open).toHaveBeenCalledWith(startResult.authorize_url, "jarela-gmail-oauth", "width=560,height=720");
      expect(screen.getByRole("button", { name: "Waiting…" })).toHaveProperty("disabled", true);
      await poll(1499);
      expect(api.integrations.gmailOauthStatus).not.toHaveBeenCalled();
      await poll(1);
      expect(api.integrations.gmailOauthStatus).toHaveBeenCalledWith(startResult.state);
    });

    it("requires Outlook app credentials for an unconfigured integration", async () => {
      render(<IntegrationCard definition={mailDefinition("outlook")} onChanged={onChanged} />);
      await connect("outlook");
      expect(screen.getByText("Enter the OAuth client ID and client secret first.")).toBeTruthy();
      expect(api.integrations.outlookOauthStart).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    });

    it("sanitizes pasted Outlook app inputs", async () => {
      render(<IntegrationCard definition={mailDefinition("outlook")} onChanged={onChanged} />);
      fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: " synthetic-\u200bclient " } });
      fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: " synthetic-\u200bsecret " } });
      await connect("outlook");
      expect(api.integrations.outlookOauthStart).toHaveBeenCalledWith({
        client_id: "synthetic-client", client_secret: "synthetic-secret", credential_id: undefined,
      });
    });

    it.each(["gmail", "outlook"] as const)("reconnects a named %s credential without sending mask sentinels", async (provider) => {
      const credential = mailCredential(provider);
      credential.params.client_id = "***";
      render(<IntegrationCard definition={mailDefinition(provider)} credential={credential} onChanged={onChanged} />);
      await connect(provider);
      const start = provider === "gmail" ? api.integrations.gmailOauthStart : api.integrations.outlookOauthStart;
      expect(start).toHaveBeenCalledWith({
        client_id: undefined, client_secret: undefined, credential_id: credential.id,
      });
    });

    it("reconnects the configured default Outlook credential without new inputs", async () => {
      const status: IntegrationStatus = {
        name: "outlook", configured: true, values: { client_secret: "********" }, updated_at: null,
      };
      render(<IntegrationCard definition={mailDefinition("outlook")} status={status} onChanged={onChanged} />);
      await connect("outlook");
      expect(api.integrations.outlookOauthStart).toHaveBeenCalledWith({
        client_id: undefined, client_secret: undefined, credential_id: undefined,
      });
    });

    it.each(["gmail", "outlook"] as const)("refreshes once after %s authorization completes", async (provider) => {
      const status = provider === "gmail" ? api.integrations.gmailOauthStatus : api.integrations.outlookOauthStatus;
      vi.mocked(status).mockResolvedValue({ status: "done" });
      render(<IntegrationCard definition={mailDefinition(provider)} credential={mailCredential(provider)} onChanged={onChanged} />);
      await connect(provider);
      await poll();
      expect(screen.getByText(`Connected to ${provider === "gmail" ? "Gmail" : "Outlook"}. Refresh token saved.`)).toBeTruthy();
      expect(closePopup).toHaveBeenCalledOnce();
      expect(onChanged).toHaveBeenCalledOnce();
      await poll(6000);
      expect(status).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: provider === "gmail" ? "Connect Gmail" : "Connect Outlook" })).toHaveProperty("disabled", false);
    });

    it.each([
      [{ status: "error", error: "Synthetic denial" }, "Synthetic denial"],
      [{ status: "error" }, "Authorization failed."],
      [{ status: "unknown" }, "Authorization session expired."],
    ] as const)("stops polling on terminal status %j", async (result, message) => {
      vi.mocked(api.integrations.gmailOauthStatus).mockResolvedValue(result);
      render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      await poll(6000);
      expect(screen.getByText(message)).toBeTruthy();
      expect(api.integrations.gmailOauthStatus).toHaveBeenCalledOnce();
      expect(onChanged).not.toHaveBeenCalled();
    });

    it("reports blocked popups without starting polling", async () => {
      vi.mocked(window.open).mockReturnValue(null);
      render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      expect(screen.getByText("Browser blocked the OAuth popup. Allow popups for this site and retry.")).toBeTruthy();
      await poll();
      expect(api.integrations.gmailOauthStatus).not.toHaveBeenCalled();
    });

    it.each(["start", "status"] as const)("reports %s request failures", async (stage) => {
      const request = stage === "start" ? api.integrations.gmailOauthStart : api.integrations.gmailOauthStatus;
      vi.mocked(request).mockRejectedValue(new Error("Synthetic network failure"));
      render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      await poll(6000);
      expect(screen.getByText("Synthetic network failure")).toBeTruthy();
      expect(onChanged).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Connect Gmail" })).toHaveProperty("disabled", false);
    });

    it("expires pending authorization after ten minutes", async () => {
      render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      await poll(10 * 60_000);
      expect(screen.getByRole("button", { name: "Waiting…" })).toBeTruthy();
      await poll();
      expect(screen.getByText("Timed out waiting for authorization.")).toBeTruthy();
      const calls = vi.mocked(api.integrations.gmailOauthStatus).mock.calls.length;
      await poll(6000);
      expect(api.integrations.gmailOauthStatus).toHaveBeenCalledTimes(calls);
    });

    it("stops scheduled polling on unmount", async () => {
      const { unmount } = render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      unmount();
      await poll(6000);
      expect(api.integrations.gmailOauthStatus).not.toHaveBeenCalled();
    });

    it("does not open a popup when authorization start completes after unmount", async () => {
      const pending = deferred<typeof startResult>();
      vi.mocked(api.integrations.gmailOauthStart).mockReturnValue(pending.promise);
      const { unmount } = render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      unmount();
      await act(async () => { pending.resolve(startResult); });
      expect(window.open).not.toHaveBeenCalled();
      await poll();
      expect(api.integrations.gmailOauthStatus).not.toHaveBeenCalled();
    });

    it("ignores an in-flight status response after unmount", async () => {
      const pending = deferred<Awaited<ReturnType<typeof api.integrations.gmailOauthStatus>>>();
      vi.mocked(api.integrations.gmailOauthStatus).mockReturnValue(pending.promise);
      const { unmount } = render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      await poll();
      unmount();
      await act(async () => { pending.resolve({ status: "done" }); });
      expect(onChanged).not.toHaveBeenCalled();
      expect(closePopup).not.toHaveBeenCalled();
    });

    it("keeps at most one status request in flight", async () => {
      const pending = deferred<Awaited<ReturnType<typeof api.integrations.gmailOauthStatus>>>();
      vi.mocked(api.integrations.gmailOauthStatus).mockReturnValue(pending.promise);
      render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      await poll(6000);
      expect(api.integrations.gmailOauthStatus).toHaveBeenCalledOnce();
      await act(async () => { pending.resolve({ status: "done" }); });
      expect(onChanged).toHaveBeenCalledOnce();
    });

    it("expires even a stuck request and ignores its result after retry", async () => {
      const pending = deferred<Awaited<ReturnType<typeof api.integrations.gmailOauthStatus>>>();
      vi.mocked(api.integrations.gmailOauthStatus).mockReturnValueOnce(pending.promise);
      render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      await poll(10 * 60_000 + 1500);
      expect(screen.getByText("Timed out waiting for authorization.")).toBeTruthy();
      vi.mocked(api.integrations.gmailOauthStatus).mockResolvedValue({ status: "done" });
      await connect();
      await poll();
      expect(onChanged).toHaveBeenCalledOnce();
      await act(async () => { pending.resolve({ status: "error", error: "Obsolete failure" }); });
      expect(screen.queryByText("Obsolete failure")).toBeNull();
      expect(screen.getByText("Connected to Gmail. Refresh token saved.")).toBeTruthy();
      expect(onChanged).toHaveBeenCalledOnce();
    });

    it("cancels the old flow when the bound credential changes", async () => {
      const pending = deferred<Awaited<ReturnType<typeof api.integrations.gmailOauthStatus>>>();
      vi.mocked(api.integrations.gmailOauthStatus).mockReturnValueOnce(pending.promise);
      const credential = mailCredential("gmail");
      const { rerender } = render(<IntegrationCard definition={mailDefinition("gmail")} credential={credential} onChanged={onChanged} />);
      await connect();
      await poll();
      rerender(<IntegrationCard definition={mailDefinition("gmail")} credential={{ ...credential, id: "integration-gmail-personal" }} onChanged={onChanged} />);
      expect(screen.getByRole("button", { name: "Connect Gmail" })).toHaveProperty("disabled", false);
      await act(async () => { pending.resolve({ status: "done" }); });
      expect(onChanged).not.toHaveBeenCalled();
      await connect();
      expect(api.integrations.gmailOauthStart).toHaveBeenLastCalledWith({
        client_id: "synthetic-client", client_secret: undefined, credential_id: "integration-gmail-personal",
      });
    });

    it("cancels default-credential OAuth when switching to create mode", async () => {
      const pending = deferred<Awaited<ReturnType<typeof api.integrations.gmailOauthStatus>>>();
      vi.mocked(api.integrations.gmailOauthStatus).mockReturnValueOnce(pending.promise);
      const { rerender } = render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      await poll();
      rerender(<IntegrationCard definition={mailDefinition("gmail")} createNew onChanged={onChanged} />);
      await act(async () => { pending.resolve({ status: "done" }); });
      expect(onChanged).not.toHaveBeenCalled();
      expect(screen.queryByText("Connected to Gmail. Refresh token saved.")).toBeNull();
      expect(screen.getByRole("button", { name: "Connect Gmail" })).toHaveProperty("disabled", true);
    });

    it("notifies the current parent callback without restarting polling on rerender", async () => {
      vi.mocked(api.integrations.gmailOauthStatus).mockResolvedValue({ status: "done" });
      const latestOnChanged = vi.fn();
      const { rerender } = render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      rerender(<IntegrationCard definition={mailDefinition("gmail")} onChanged={latestOnChanged} />);
      await poll();
      expect(latestOnChanged).toHaveBeenCalledOnce();
      expect(onChanged).not.toHaveBeenCalled();
      expect(api.integrations.gmailOauthStart).toHaveBeenCalledOnce();
    });

    it("still refreshes saved credentials when the popup cannot be closed", async () => {
      vi.mocked(window.close).mockImplementation(() => { throw new Error("Synthetic close failure"); });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(api.integrations.gmailOauthStatus).mockResolvedValue({ status: "done" });
      render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await connect();
      await poll();
      expect(onChanged).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith("Could not close the OAuth popup; close it manually.");
      expect(screen.getByText("Connected to Gmail. Refresh token saved.")).toBeTruthy();
    });

    it("surfaces parent refresh failures after successful authorization", async () => {
      vi.mocked(api.integrations.gmailOauthStatus).mockResolvedValue({ status: "done" });
      render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={() => { throw new Error("Synthetic refresh failure"); }} />);
      await connect();
      await poll();
      expect(screen.getByText("Synthetic refresh failure")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Connect Gmail" })).toHaveProperty("disabled", false);
    });

    it("requires saving a new credential before OAuth or testing", () => {
      render(<IntegrationCard definition={mailDefinition("gmail")} createNew onChanged={onChanged} />);
      expect(screen.getByRole("button", { name: "Connect Gmail" })).toHaveProperty("disabled", true);
      expect(screen.getByRole("button", { name: "Test" })).toHaveProperty("disabled", true);
    });

    it("saves a named credential without overwriting masked secrets", async () => {
      const credential = mailCredential("gmail");
      vi.spyOn(api.credentials, "update").mockResolvedValue(credential);
      render(<IntegrationCard definition={mailDefinition("gmail")} credential={credential} onChanged={onChanged} />);
      fireEvent.change(screen.getByLabelText(/Label/), { target: { value: " Personal " } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
      expect(api.credentials.update).toHaveBeenCalledWith(credential.id, {
        label: "Personal", params: { client_id: "synthetic-client" },
      });
      expect(onChanged).toHaveBeenCalledOnce();
    });

    it("creates an additional credential without promoting it", async () => {
      vi.spyOn(api.credentials, "create").mockResolvedValue(mailCredential("gmail"));
      render(<IntegrationCard definition={mailDefinition("gmail")} createNew onChanged={onChanged} />);
      fireEvent.change(screen.getByLabelText(/Label/), { target: { value: " Personal " } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create" })); });
      expect(api.credentials.create).toHaveBeenCalledWith({
        type: "integration", provider: "gmail", auth_method: "oauth", label: "Personal", params: {},
      });
      expect(onChanged).toHaveBeenCalledOnce();
    });

    it.each(["gmail", "outlook"] as const)("preserves %s connection labels and disabled-state guidance", (provider) => {
      const label = provider === "gmail" ? "Gmail" : "Outlook";
      const vendor = provider === "gmail" ? "Google" : "Microsoft";
      const { rerender } = render(<IntegrationCard definition={mailDefinition(provider)} onChanged={onChanged} />);
      expect(screen.getByRole("button", { name: `Connect ${label}` })).toHaveProperty(
        "title", `Authorize ${label} + Calendar via ${vendor} OAuth — opens a browser window`,
      );
      rerender(<IntegrationCard definition={mailDefinition(provider)} createNew onChanged={onChanged} />);
      const button = screen.getByRole("button", { name: `Connect ${label}` });
      expect(button).toHaveProperty("disabled", true);
      expect(button).toHaveProperty("title", `Save this credential first, then connect ${label}`);
    });

    it("does not show OAuth controls for non-OAuth integrations", () => {
      render(<IntegrationCard definition={claudeCodeDefinition} onChanged={onChanged} />);
      expect(screen.queryByRole("button", { name: /^Connect / })).toBeNull();
    });

    it("prioritizes an existing credential even when createNew is also supplied", async () => {
      const credential = mailCredential("gmail");
      vi.spyOn(api.credentials, "update").mockResolvedValue(credential);
      const create = vi.spyOn(api.credentials, "create");
      render(<IntegrationCard definition={mailDefinition("gmail")} credential={credential} createNew onChanged={onChanged} />);
      expect(screen.getByRole("button", { name: "Connect Gmail" })).toHaveProperty("disabled", false);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
      expect(api.credentials.update).toHaveBeenCalledWith(credential.id, {
        label: "Work", params: { client_id: "synthetic-client" },
      });
      expect(create).not.toHaveBeenCalled();
      expect(onChanged).toHaveBeenCalledOnce();
    });

    it.each(["edit", "create"] as const)("sends null for a blank label in %s mode", async (mode) => {
      const credential = mailCredential("gmail");
      const update = vi.spyOn(api.credentials, "update").mockResolvedValue(credential);
      const create = vi.spyOn(api.credentials, "create").mockResolvedValue(credential);
      render(<IntegrationCard definition={mailDefinition("gmail")} credential={mode === "edit" ? credential : undefined} createNew={mode === "create"} onChanged={onChanged} />);
      fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "  " } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: mode === "edit" ? "Save" : "Create" })); });
      if (mode === "edit") {
        expect(update).toHaveBeenCalledWith(credential.id, {
          label: null, params: { client_id: "synthetic-client" },
        });
      } else {
        expect(create).toHaveBeenCalledWith({
          type: "integration", provider: "gmail", auth_method: "oauth", label: null, params: {},
        });
      }
      expect(onChanged).toHaveBeenCalledOnce();
    });

    it("derives API-key auth for new non-OAuth credentials", async () => {
      const create = vi.spyOn(api.credentials, "create").mockResolvedValue(mailCredential("gmail"));
      render(<IntegrationCard definition={claudeCodeDefinition} createNew onChanged={onChanged} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create" })); });
      expect(create).toHaveBeenCalledWith({
        type: "integration", provider: "claude-code", auth_method: "api_key", label: null, params: {},
      });
    });

    it.each(["edit", "create"] as const)("reports %s failures without a success notification", async (mode) => {
      vi.spyOn(api.credentials, "update").mockRejectedValue(new Error("Synthetic save failure"));
      vi.spyOn(api.credentials, "create").mockRejectedValue(new Error("Synthetic save failure"));
      const name = mode === "edit" ? "Save" : "Create";
      render(<IntegrationCard definition={mailDefinition("gmail")} credential={mode === "edit" ? mailCredential("gmail") : undefined} createNew={mode === "create"} onChanged={onChanged} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
      expect(screen.getByText("Synthetic save failure")).toBeTruthy();
      expect(screen.getByRole("button", { name })).toHaveProperty("disabled", false);
      expect(onChanged).not.toHaveBeenCalled();
    });

    it("preserves the default-credential save path and returned masks", async () => {
      const saved: IntegrationStatus = {
        name: "gmail", configured: true, values: { client_secret: "********" }, updated_at: "2026-01-02T00:00:00Z",
      };
      const save = vi.spyOn(api.integrations, "save").mockResolvedValue(saved);
      const list = vi.spyOn(api.credentials, "list");
      render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
      expect(save).toHaveBeenCalledWith("gmail", {});
      expect(screen.getByLabelText("Client secret")).toHaveProperty("value", "********");
      expect(list).not.toHaveBeenCalled();
      expect(onChanged).toHaveBeenCalledOnce();
    });

    it("waits for the default credential label update before notifying the parent", async () => {
      const credential = { ...mailCredential("gmail"), is_default: true };
      const pending = deferred<Credential>();
      vi.spyOn(api.integrations, "save").mockResolvedValue({
        name: "gmail", configured: true, values: { client_secret: "********" }, updated_at: null,
      });
      vi.spyOn(api.credentials, "list").mockResolvedValue([credential]);
      const update = vi.spyOn(api.credentials, "update").mockReturnValue(pending.promise);
      render(<IntegrationCard definition={mailDefinition("gmail")} onChanged={onChanged} />);
      fireEvent.change(screen.getByLabelText(/Label/), { target: { value: " Personal " } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
      expect(update).toHaveBeenCalledWith(credential.id, { label: "Personal" });
      expect(screen.getByLabelText("Client secret")).toHaveProperty("value", "********");
      expect(onChanged).not.toHaveBeenCalled();
      await act(async () => { pending.resolve(credential); });
      expect(onChanged).toHaveBeenCalledOnce();
    });

    it.each([true, false])("only removes a named credential when confirmation is %s", async (confirmed) => {
      const credential = mailCredential("gmail");
      const confirm = vi.spyOn(confirmation, "confirmAction").mockResolvedValue(confirmed);
      const remove = vi.spyOn(api.credentials, "delete").mockResolvedValue(undefined);
      const clear = vi.spyOn(api.integrations, "delete");
      const onDeleted = vi.fn();
      render(<IntegrationCard definition={mailDefinition("gmail")} credential={credential} createNew onChanged={onChanged} onDeleted={onDeleted} />);
      const button = screen.getByRole("button", { name: "Delete" });
      expect(button).toHaveProperty("title", "Delete this credential");
      await act(async () => { fireEvent.click(button); });
      expect(confirm).toHaveBeenCalledWith({ message: 'Delete credential "Work"?', destructive: true });
      expect(remove).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      if (confirmed) expect(remove).toHaveBeenCalledWith(credential.id);
      expect(clear).not.toHaveBeenCalled();
      expect(onChanged).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      expect(onDeleted).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    });

    it.each([true, false])("only clears default integration values when confirmation is %s", async (confirmed) => {
      const confirm = vi.spyOn(confirmation, "confirmAction").mockResolvedValue(confirmed);
      const clear = vi.spyOn(api.integrations, "delete").mockResolvedValue(undefined);
      const remove = vi.spyOn(api.credentials, "delete");
      render(<IntegrationCard definition={mailDefinition("gmail")} status={{
        name: "gmail", configured: true, values: { client_id: "synthetic-client" }, updated_at: null,
      }} onChanged={onChanged} />);
      const button = screen.getByRole("button", { name: "Clear" });
      expect(button).toHaveProperty("title", "Remove saved credentials");
      await act(async () => { fireEvent.click(button); });
      expect(confirm).toHaveBeenCalledWith({
        message: "Remove saved credentials for Gmail?", destructive: true, confirmLabel: "Remove",
      });
      expect(clear).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      if (confirmed) expect(clear).toHaveBeenCalledWith("gmail");
      expect(remove).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Client ID")).toHaveProperty("value", confirmed ? "" : "synthetic-client");
      expect(onChanged).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    });

    it.each([false, true])("hides removal for an unsaved credential (createNew=%s)", (createNew) => {
      render(<IntegrationCard definition={mailDefinition("gmail")} createNew={createNew} onChanged={onChanged} />);
      expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    });

    it("does not offer to clear the saved default while creating an additional credential", () => {
      render(<IntegrationCard definition={mailDefinition("gmail")} createNew status={{
        name: "gmail", configured: true, values: {}, updated_at: null,
      }} onChanged={onChanged} />);
      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    });

    it("preserves default/additional badges, label placeholders, and promotion wiring", async () => {
      const credential = mailCredential("gmail");
      const update = vi.spyOn(api.credentials, "update").mockResolvedValue(credential);
      const { rerender } = render(<IntegrationCard definition={mailDefinition("gmail")} credential={credential} onChanged={onChanged} />);
      expect(screen.getByText("additional")).toBeTruthy();
      expect(screen.getByLabelText(/Label/)).toHaveProperty("placeholder", "Untitled credential");
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set default" })); });
      expect(update).toHaveBeenCalledWith(credential.id, { is_default: true });
      expect(onChanged).toHaveBeenCalledOnce();
      rerender(<IntegrationCard definition={mailDefinition("gmail")} credential={{ ...credential, is_default: true }} onChanged={onChanged} />);
      expect(screen.getByText("default")).toBeTruthy();
      expect(screen.getByLabelText(/Label/)).toHaveProperty("placeholder", "Default credential");
      expect(screen.queryByRole("button", { name: "Set default" })).toBeNull();
    });

    it("preserves field provenance and clears saved masks only when the secret is focused", () => {
      render(<IntegrationCard definition={mailDefinition("gmail")} status={{
        name: "gmail", configured: true, updated_at: null,
        values: { client_id: "synthetic-client", client_secret: "********" }, source: { client_id: "rc" },
      }} onChanged={onChanged} />);
      expect(screen.getByText("from shell")).toBeTruthy();
      expect(screen.getByLabelText("Client secret")).toHaveProperty("value", "********");
      fireEvent.focus(screen.getByLabelText(/Client ID/));
      expect(screen.getByLabelText(/Client ID/)).toHaveProperty("value", "synthetic-client");
      fireEvent.focus(screen.getByLabelText("Client secret"));
      expect(screen.getByLabelText("Client secret")).toHaveProperty("value", "");
    });

    it("renders test feedback from the action owner", async () => {
      vi.spyOn(api.integrations, "test").mockResolvedValue({ ok: true, detail: { displayName: "Synthetic account" } });
      render(<IntegrationCard definition={mailDefinition("gmail")} credential={mailCredential("gmail")} onChanged={onChanged} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Test" })); });
      expect(screen.getByText("Connected as Synthetic account")).toBeTruthy();
      expect(api.integrations.test).toHaveBeenCalledWith("gmail", "integration-gmail-work");
    });

    it("shows a clear failure instead of leaving an unhandled rejection", async () => {
      vi.spyOn(confirmation, "confirmAction").mockResolvedValue(true);
      vi.spyOn(api.integrations, "delete").mockRejectedValue(new Error("Synthetic clear failure"));
      render(<IntegrationCard definition={mailDefinition("gmail")} status={{
        name: "gmail", configured: true, updated_at: null, values: { client_id: "synthetic-client" },
      }} onChanged={onChanged} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Clear" })); });
      expect(screen.getByText("Synthetic clear failure")).toBeTruthy();
      expect(screen.getByLabelText("Client ID")).toHaveProperty("value", "synthetic-client");
      expect(onChanged).not.toHaveBeenCalled();
    });
  });
});