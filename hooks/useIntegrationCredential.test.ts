// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { api } from "@/api/client";
import type { Credential, IntegrationDefinition, IntegrationStatus } from "@/api/types";
import * as confirmation from "@/lib/ui/confirm";
import { useIntegrationCredential, type CredentialEditorMode } from "./useIntegrationCredential";

const definition: IntegrationDefinition = {
  name: "gmail", label: "Gmail", description: "Synthetic integration",
  fields: [
    { key: "client_id", label: "Client ID", secret: false, required: false },
    { key: "client_secret", label: "Client secret", secret: true, required: false },
  ],
};
const credential: Credential = {
  id: "integration-gmail-work", type: "integration", provider: "gmail", auth_method: "oauth",
  label: "Work", is_default: false, params: { client_id: "synthetic-client", client_secret: "***" },
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};
const status: IntegrationStatus = {
  name: "gmail", configured: true, values: { client_id: "default-client", client_secret: "********" },
  updated_at: "2026-01-01T00:00:00Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function editor(mode: CredentialEditorMode = { kind: "edit", credential }) {
  const onChanged = vi.fn();
  const onDeleted = vi.fn();
  const hook = renderHook(() => useIntegrationCredential({ definition, mode, status, onChanged, onDeleted }));
  return { ...hook, onChanged, onDeleted };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useIntegrationCredential", () => {
  it("exposes canonical state/commands, flat parity, and a named save", async () => {
    const update = vi.spyOn(api.credentials, "update").mockResolvedValue(credential);
    const { result, onChanged } = editor();
    expect(result.current.state.values).toEqual(credential.params);
    expect(result.current.state.label).toBe("Work");
    for (const [key, value] of Object.entries(result.current.state)) {
      expect(Reflect.get(result.current, key)).toBe(value);
    }
    for (const [key, value] of Object.entries(result.current.commands)) {
      expect(Reflect.get(result.current, key)).toBe(value);
    }
    await act(async () => { await result.current.commands.save(); });
    expect(update).toHaveBeenCalledWith(credential.id, { label: "Work", params: { client_id: "synthetic-client" } });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(result.current.state.saving).toBe(false);
  });

  it.each([
    [{ warning: "Synthetic warning", displayName: "Synthetic name" }, "Synthetic warning"],
    [{ displayName: "Synthetic name", email: "sample@example.com", version: "1.0" }, "Connected as Synthetic name"],
    [{ email: "sample@example.com", version: "1.0" }, "Connected as sample@example.com"],
    [{ version: "1.0", auth: "api_key" }, "Claude Code ready (1.0)"],
    [{ version: "1.0", auth: "login" }, "Claude Code detected (1.0)"],
    [{}, "Connection ok"],
    [{ displayName: "", warning: "", version: "" }, "Connection ok"],
  ])("formats successful probe details %j", async (detail, message) => {
    vi.spyOn(api.integrations, "test").mockResolvedValue({ ok: true, detail });
    const { result } = editor();
    await act(async () => { await result.current.commands.test(); });
    expect(result.current.state.testResult).toEqual({ ok: true, message });
    expect(result.current.state.testing).toBe(false);
    expect(api.integrations.test).toHaveBeenCalledWith("gmail", credential.id);
  });

  it.each([
    [{ ok: false, error: "Synthetic denial" }, "Synthetic denial"],
    [{ ok: false }, "Test failed"],
  ])("formats unsuccessful probe results %j", async (response, message) => {
    vi.spyOn(api.integrations, "test").mockResolvedValue(response);
    const { result } = editor({ kind: "default" });
    await act(async () => { await result.current.commands.test(); });
    expect(result.current.state.testResult).toEqual({ ok: false, message });
    expect(api.integrations.test).toHaveBeenCalledWith("gmail", undefined);
  });

  it("reports probe request failures and clears the loading state", async () => {
    vi.spyOn(api.integrations, "test").mockRejectedValue(new Error("Synthetic probe failure"));
    const { result } = editor();
    await act(async () => { await result.current.commands.test(); });
    expect(result.current.state.testResult).toEqual({ ok: false, message: "Synthetic probe failure" });
    expect(result.current.state.testing).toBe(false);
  });

  it("preserves unsaved edits until the saved timestamp changes", () => {
    const mode: CredentialEditorMode = { kind: "edit", credential };
    const { result, rerender } = renderHook(({ current }) => useIntegrationCredential({
      definition, mode: { ...mode, credential: current }, status, onChanged: vi.fn(),
    }), { initialProps: { current: credential } });
    act(() => {
      result.current.commands.setLabel("Unsaved label");
      result.current.commands.setValues({ client_id: "unsaved-client" });
    });
    rerender({ current: { ...credential, params: { client_id: "ignored-client" } } });
    expect(result.current.state.label).toBe("Unsaved label");
    expect(result.current.state.values).toEqual({ client_id: "unsaved-client" });
    rerender({ current: { ...credential, label: "Saved label", updated_at: "2026-01-02T00:00:00Z" } });
    expect(result.current.state.label).toBe("Saved label");
    expect(result.current.state.values).toEqual(credential.params);
  });

  it.each(["lookup", "label", "missing"] as const)("reports a partial default save when %s fails", async (failure) => {
    vi.spyOn(api.integrations, "save").mockResolvedValue(status);
    const list = vi.spyOn(api.credentials, "list").mockResolvedValue(
      failure === "missing" ? [] : [{ ...credential, is_default: true }],
    );
    const update = vi.spyOn(api.credentials, "update").mockResolvedValue(credential);
    if (failure === "lookup") list.mockRejectedValue(new Error("Synthetic lookup failure"));
    if (failure === "label") update.mockRejectedValue(new Error("Synthetic label failure"));
    const { result, onChanged } = editor({ kind: "default" });
    act(() => { result.current.commands.setLabel("Personal"); });
    await act(async () => { await result.current.commands.save(); });
    expect(result.current.state.values).toEqual(status.values);
    expect(result.current.state.error).toBe(failure === "missing"
      ? "Credentials saved, but no default credential was found to update its label."
      : `Synthetic ${failure} failure`);
    expect(result.current.state.saving).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("reseeds the form when changing modes without requiring a status timestamp change", () => {
    const { result, rerender } = renderHook(({ mode }: { mode: CredentialEditorMode }) =>
      useIntegrationCredential({ definition, mode, status, onChanged: vi.fn() }),
    { initialProps: { mode: { kind: "edit", credential } } });
    expect(result.current.state.label).toBe("Work");
    act(() => {
      result.current.commands.setLabel("Unsaved work");
      result.current.commands.setValues({ client_id: "unsaved-client" });
    });
    rerender({ mode: { kind: "create" } });
    expect(result.current.state.values).toEqual(status.values);
    expect(result.current.state.label).toBe("");
    act(() => { result.current.commands.setLabel("Unsaved additional credential"); });
    rerender({ mode: { kind: "default" } });
    expect(result.current.state.label).toBe("");
    expect(result.current.state.values).toEqual(status.values);
  });

  it.each(["default", "edit"] as const)("reports %s removal failures without notifying success", async (kind) => {
    vi.spyOn(confirmation, "confirmAction").mockResolvedValue(true);
    vi.spyOn(api.integrations, "delete").mockRejectedValue(new Error("Synthetic removal failure"));
    vi.spyOn(api.credentials, "delete").mockRejectedValue(new Error("Synthetic removal failure"));
    const { result, onChanged, onDeleted } = editor(kind === "edit" ? { kind, credential } : { kind });
    await act(async () => { await result.current.commands.remove(); });
    expect(result.current.state.error).toBe("Synthetic removal failure");
    expect(onChanged).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("promotes exactly the bound credential and reports promotion failures", async () => {
    const update = vi.spyOn(api.credentials, "update").mockResolvedValue(credential);
    const { result, onChanged } = editor();
    await act(async () => { await result.current.commands.promoteToDefault(); });
    expect(update).toHaveBeenCalledWith(credential.id, { is_default: true });
    expect(onChanged).toHaveBeenCalledOnce();
    update.mockRejectedValueOnce(new Error("Synthetic promotion failure"));
    await act(async () => { await result.current.commands.promoteToDefault(); });
    expect(result.current.state.error).toBe("Synthetic promotion failure");
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("does not remove or promote an unsaved credential", async () => {
    const confirm = vi.spyOn(confirmation, "confirmAction");
    const update = vi.spyOn(api.credentials, "update");
    const remove = vi.spyOn(api.credentials, "delete");
    const { result, onChanged } = editor({ kind: "create" });
    await act(async () => {
      await result.current.commands.remove();
      await result.current.commands.promoteToDefault();
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not let a late default save overwrite a newly selected named credential", async () => {
    const pending = deferred<IntegrationStatus>();
    vi.spyOn(api.integrations, "save").mockReturnValue(pending.promise);
    const onChanged = vi.fn();
    const { result, rerender } = renderHook(({ mode }: { mode: CredentialEditorMode }) =>
      useIntegrationCredential({ definition, mode, status, onChanged }),
    { initialProps: { mode: { kind: "default" } } });
    let saving!: Promise<void>;
    act(() => { saving = result.current.commands.save(); });
    expect(result.current.state.saving).toBe(true);
    rerender({ mode: { kind: "edit", credential } });
    expect(result.current.state.saving).toBe(false);
    await act(async () => { pending.resolve(status); await saving; });
    expect(result.current.state.values).toEqual(credential.params);
    expect(result.current.state.label).toBe("Work");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not execute a pending removal confirmation after selecting another credential", async () => {
    const pending = deferred<boolean>();
    vi.spyOn(confirmation, "confirmAction").mockReturnValue(pending.promise);
    const remove = vi.spyOn(api.credentials, "delete");
    const { result, rerender } = renderHook(({ current }) =>
      useIntegrationCredential({ definition, mode: { kind: "edit", credential: current }, onChanged: vi.fn() }),
    { initialProps: { current: credential } });
    let removing!: Promise<void>;
    act(() => { removing = result.current.commands.remove(); });
    rerender({ current: { ...credential, id: "integration-gmail-personal" } });
    await act(async () => { pending.resolve(true); await removing; });
    expect(remove).not.toHaveBeenCalled();
  });

  it("ignores an in-flight probe after unmount", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.integrations.test>>>();
    vi.spyOn(api.integrations, "test").mockReturnValue(pending.promise);
    const { result, unmount, onChanged } = editor();
    let testing!: Promise<void>;
    act(() => { testing = result.current.commands.test(); });
    expect(result.current.state.testing).toBe(true);
    unmount();
    await act(async () => { pending.resolve({ ok: true }); await testing; });
    expect(result.current.state.testResult).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
