import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  raw: vi.fn(), env: vi.fn(), setResolver: vi.fn(),
}));
vi.mock("@/lib/stores/integrations", () => ({ getIntegrationRaw: mocks.raw }));
vi.mock("../optional-package", () => ({
  optionalTools: () => [],
  optionalFunction: (_package: string, name: string) => name === "setAuthResolver" ? mocks.setResolver : mocks.env,
}));
import { icloudDefaultPackages } from "./icloud";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.env.mockReturnValue({ error: "No environment credentials" });
});

describe("iCloud SMTP credential bridge", () => {
  it("forwards the saved mail identity without changing the Apple ID", () => {
    mocks.raw.mockReturnValue({
      apple_id: "apple-account@example.com", app_password: "synthetic", mail_address: "synthetic@icloud.com",
    });
    const registered = icloudDefaultPackages[0].register();
    expect(registered.resolveAuth()).toEqual({
      appleId: "apple-account@example.com", appPassword: "synthetic", mailAddress: "synthetic@icloud.com",
    });
    expect(mocks.raw).toHaveBeenCalledWith("icloud");
    registered.unregister();
  });

  it("preserves complete environment credentials instead of mixing accounts", () => {
    mocks.env.mockReturnValue({
      appleId: "environment@icloud.com", appPassword: "synthetic-env", mailAddress: "environment@icloud.com",
    });
    const registered = icloudDefaultPackages[0].register();
    expect(registered.resolveAuth()).toMatchObject({ appleId: "environment@icloud.com", mailAddress: "environment@icloud.com" });
    expect(mocks.raw).not.toHaveBeenCalled();
    registered.unregister();
  });

  it("keeps existing credentials usable when the optional mail identity is absent", () => {
    mocks.raw.mockReturnValue({ apple_id: "synthetic@icloud.com", app_password: "synthetic" });
    const registered = icloudDefaultPackages[0].register();
    expect(registered.resolveAuth()).toEqual({
      appleId: "synthetic@icloud.com", appPassword: "synthetic", mailAddress: undefined,
    });
    registered.unregister();
  });
});
