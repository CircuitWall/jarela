// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { NetworkSection } from "./NetworkSection";
import { AllowedSitesSection } from "./AllowedSitesSection";

const mocks = vi.hoisted(() => ({
  proxy: { get: vi.fn(), save: vi.fn(), clear: vi.fn() },
  sites: { list: vi.fn(), add: vi.fn(), remove: vi.fn(), setSsrfBypass: vi.fn() },
  confirm: vi.fn(),
}));
vi.mock("@/api/client", () => ({ api: { proxy: mocks.proxy, allowedSites: mocks.sites } }));
vi.mock("@/lib/ui/confirm", () => ({ confirmAction: mocks.confirm }));
vi.mock("@/hooks/useDismissGuard", () => ({ useDirty: () => true }));

const envelope = {
  env_override: false,
  config: {
    mode: "manual", scheme: "http", host: "proxy.example.test", port: 8080,
    username: null, password: "********", no_proxy: null, ca_bundle: null,
    updated_at: "2026-01-01",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.proxy.get.mockResolvedValue(envelope);
  mocks.proxy.save.mockResolvedValue({ ...envelope, applied: { source: "manual", note: "Synthetic apply" } });
  mocks.sites.list.mockResolvedValue({ sites: [] });
  mocks.sites.add.mockResolvedValue({});
});

it("preserves proxy normalization and masked-password replacement on save", async () => {
  render(<NetworkSection />);
  const password = await screen.findByLabelText("Password (optional)");
  expect(password).toHaveProperty("value", "********");
  fireEvent.focus(password);
  expect(password).toHaveProperty("value", "");
  fireEvent.change(password, { target: { value: "synthetic-only" } });
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: " proxy.example.test " } });
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "4242" } });
  fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
  await waitFor(() => expect(mocks.proxy.save).toHaveBeenCalledWith({
    mode: "manual", scheme: "http", host: "proxy.example.test", port: 4242,
    username: null, password: "synthetic-only", no_proxy: null, ca_bundle: null,
  }));
  expect(await screen.findByText("— Synthetic apply")).toBeTruthy();
  expect(password).toHaveProperty("value", "********");
});

it("validates a CA upload and retains the draft when saving fails", async () => {
  const { container } = render(<NetworkSection />);
  await screen.findByLabelText("Host");
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["synthetic"], "synthetic.pem");
  Object.defineProperty(file, "text", { value: async () => "not a PEM block" });
  fireEvent.change(input, { target: { files: [file] } });
  expect(await screen.findByText(/does not contain a PEM certificate/)).toBeTruthy();
  const pem = "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----";
  const validFile = new File([pem], "synthetic-valid.pem");
  Object.defineProperty(validFile, "text", { value: async () => pem });
  fireEvent.change(input, { target: { files: [validFile] } });
  await screen.findByText("Loaded: synthetic-valid.pem");
  mocks.proxy.save.mockRejectedValueOnce(new Error("Synthetic save failure"));
  fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
  expect(await screen.findByText("Synthetic save failure")).toBeTruthy();
  expect(screen.getByText("Loaded: synthetic-valid.pem")).toBeTruthy();
  expect(mocks.proxy.save).toHaveBeenCalledWith(expect.objectContaining({ ca_bundle: pem }));
});

it("does not clear proxy configuration when confirmation is declined", async () => {
  mocks.confirm.mockResolvedValue(false);
  render(<NetworkSection />);
  fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  expect(mocks.proxy.clear).not.toHaveBeenCalled();
});

it("approves a trimmed host with its explicit intranet capability and resets the add form", async () => {
  render(<AllowedSitesSection />);
  const hostname = screen.getByPlaceholderText("jira.example.com");
  fireEvent.change(hostname, { target: { value: " intranet.example.test " } });
  fireEvent.click(screen.getByRole("checkbox", { name: "intranet" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(mocks.sites.add).toHaveBeenCalledWith({
    hostname: "intranet.example.test", ssrf_bypass: true,
  }));
  await waitFor(() => expect(hostname).toHaveProperty("value", ""));
  expect(screen.getByRole("checkbox", { name: "intranet" })).toHaveProperty("checked", false);
  expect(mocks.sites.list).toHaveBeenCalledTimes(2);
});

it("keeps a failed host approval editable and exposes its action error", async () => {
  mocks.sites.add.mockRejectedValueOnce(new Error("Synthetic site rejection"));
  render(<AllowedSitesSection />);
  const hostname = screen.getByPlaceholderText("jira.example.com");
  fireEvent.change(hostname, { target: { value: "site.example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(await screen.findByText("Synthetic site rejection")).toBeTruthy();
  expect(hostname).toHaveProperty("value", "site.example.test");
  expect(screen.getByRole("button", { name: "Approve" })).toHaveProperty("disabled", false);
});
