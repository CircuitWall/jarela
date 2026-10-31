// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecurityPanel } from "./SecurityPanel";
import { RedactionPanel } from "./RedactionPanel";

vi.mock("./SkillExecutionSettings", () => ({ SkillExecutionSettings: () => null }));

let pinEnabled: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pinEnabled = true;
  fetchMock = vi.fn().mockImplementation(async () => ({
    ok: true, json: async () => ({ state: "unlocked", pin_enabled: pinEnabled, source: "keychain" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function fillPin(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

it.each([
  [401, "Current PIN is incorrect."],
  [429, "Too many attempts. Try again later."],
  [500, "Synthetic PIN failure"],
])("preserves PIN change input and status-specific error for HTTP %s", async (status, message) => {
  render(<SecurityPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Change PIN" }));
  fillPin("Current PIN", "111111");
  fillPin("New PIN", "222222");
  fillPin("Confirm new PIN", "222222");
  fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => ({ error: "Synthetic PIN failure" }) });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByLabelText("Current PIN")).toHaveProperty("value", "111111");
  expect(screen.getByRole("button", { name: "Confirm" })).toHaveProperty("disabled", false);
  expect(fetchMock).toHaveBeenLastCalledWith("/api/v1/security/pin", expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ action: "change", currentPin: "111111", newPin: "222222" }),
  }));
});

it("rejects malformed or mismatched PINs locally and cancels without a write", async () => {
  render(<SecurityPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Change PIN" }));
  fillPin("New PIN", "12x");
  fillPin("Confirm new PIN", "12");
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(screen.getByText("PIN must be exactly 6 digits.")).toBeTruthy();
  fillPin("New PIN", "222222");
  fillPin("Confirm new PIN", "333333");
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(screen.getByText("PIN entries don't match.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("New PIN")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("enables a PIN, clears the secret inputs, and reloads the security state", async () => {
  pinEnabled = false;
  render(<SecurityPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Enable PIN" }));
  fillPin("New PIN", "111111");
  fillPin("Confirm new PIN", "111111");
  fetchMock.mockImplementationOnce(async () => {
    pinEnabled = true;
    return { ok: true };
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect((await screen.findByRole("status")).textContent).toContain("PIN enabled.");
  expect(await screen.findByRole("button", { name: "Change PIN" })).toBeTruthy();
  expect(screen.queryByLabelText("New PIN")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/security/pin", expect.objectContaining({
    body: JSON.stringify({ action: "enable", newPin: "111111" }),
  }));
});

it("keeps redaction disclosure state independent of toggle and pattern-file operations", async () => {
  const state = {
    enabled: true, config_path: "synthetic-patterns.json", config_exists: false,
    active: {
      patterns: [
        { name: "enabled-pattern", type_hint: "TOKEN", enabled: true },
        { name: "disabled-pattern", type_hint: "OTHER", enabled: false },
      ],
      heuristics: { high_entropy: { enabled: true, min_length: 20, min_entropy: 4 } },
      field_name_allowlist: ["synthetic_field"],
    },
  };
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === "PATCH") state.enabled = false;
    if (url.endsWith("/init")) {
      state.config_exists = true;
      return { ok: true, json: async () => ({ created: true, path: state.config_path }) };
    }
    return { ok: true, json: async () => state };
  });
  render(<RedactionPanel />);
  fireEvent.click(await screen.findByRole("button", { name: /1 active patterns/ }));
  expect(screen.getByText("enabled-pattern")).toBeTruthy();
  expect(screen.queryByText("disabled-pattern")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => expect(screen.getByRole("checkbox")).toHaveProperty("checked", false));
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/redaction", expect.objectContaining({
    method: "PATCH", body: JSON.stringify({ enabled: false }),
  }));
  fireEvent.click(screen.getByRole("button", { name: "Create default file" }));
  expect(await screen.findByText("Created synthetic-patterns.json")).toBeTruthy();
  expect(screen.getByText("user-edited")).toBeTruthy();
  expect(screen.getByText("enabled-pattern")).toBeTruthy();
});
