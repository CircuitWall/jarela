import { afterEach, describe, expect, it } from "vitest";
import {
  classifyInstallFailure,
  probePackageExists,
  suggestPackageName,
  _setRegistryProbeForTests,
} from "./package-registry";

afterEach(() => {
  _setRegistryProbeForTests(null);
  delete process.env.JARELA_DISABLE_REGISTRY_PROBE;
});

describe("classifyInstallFailure", () => {
  it("recognises a missing package", () => {
    expect(classifyInstallFailure("npm error code E404\nnpm error 404 Not Found")).toBe("not_found");
    expect(classifyInstallFailure("The requested resource '@scope/pkg@*' could not be found")).toBe("not_found");
  });

  it("separates auth, peer, and network failures", () => {
    expect(classifyInstallFailure("npm error code E401 Unauthorized")).toBe("forbidden");
    expect(classifyInstallFailure("npm error ERESOLVE unable to resolve dependency tree")).toBe("peer_conflict");
    expect(classifyInstallFailure("npm error code ETIMEDOUT")).toBe("network");
    expect(classifyInstallFailure("something else entirely")).toBe("unknown");
  });
});

describe("suggestPackageName", () => {
  it("suggests the catalogue entry for a one-character typo", () => {
    expect(suggestPackageName("@huggingface/transformer")).toBe("@huggingface/transformers");
  });

  it("ignores case and version suffixes", () => {
    expect(suggestPackageName("@HUGGINGFACE/transformer@latest")).toBe("@huggingface/transformers");
  });

  it("does not invent a suggestion for unrelated names", () => {
    expect(suggestPackageName("left-pad")).toBeNull();
  });

  it("accepts an explicit candidate list", () => {
    expect(suggestPackageName("@huggingface/transformer", ["@huggingface/transformers"])).toBe("@huggingface/transformers");
  });
});

describe("probePackageExists", () => {
  it("reports what the registry probe returns", async () => {
    _setRegistryProbeForTests(async () => "missing");
    expect(await probePackageExists("@scope/pkg")).toBe("missing");
    _setRegistryProbeForTests(async () => "exists");
    expect(await probePackageExists("@scope/pkg")).toBe("exists");
  });

  it("can be disabled for offline installs", async () => {
    process.env.JARELA_DISABLE_REGISTRY_PROBE = "1";
    _setRegistryProbeForTests(null);
    expect(await probePackageExists("@scope/pkg")).toBe("unknown");
  });
});
