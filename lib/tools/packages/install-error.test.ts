import { describe, expect, it } from "vitest";
import { PackageInstallError } from "./package-install";
import { describeInstallError } from "./install-error";

describe("describeInstallError", () => {
  it("maps a user typo to a 404 with the suggestion, not a 500", () => {
    const failure = describeInstallError(new PackageInstallError("not_found", "@huggingface/transformer"));

    expect(failure).toMatchObject({
      status: 404,
      body: { code: "not_found", suggestion: "@huggingface/transformers" },
    });
    expect(failure!.body.error).toContain("was not found on the npm registry");
  });

  it("uses statuses that tell the client whether retrying could help", () => {
    expect(describeInstallError(new PackageInstallError("network", "pkg"))?.status).toBe(503);
    expect(describeInstallError(new PackageInstallError("peer_conflict", "pkg"))?.status).toBe(409);
    expect(describeInstallError(new PackageInstallError("forbidden", "pkg"))?.status).toBe(403);
    expect(describeInstallError(new PackageInstallError("unknown", "pkg", "boom"))?.status).toBe(500);
  });

  it("ignores errors it does not own", () => {
    expect(describeInstallError(new Error("unknown approval id: x"))).toBeNull();
  });
});
