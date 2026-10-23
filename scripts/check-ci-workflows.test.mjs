import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { checkPlaywrightImages, installedPlaywrightVersion } from "./check-ci-workflows.mjs";

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

function workflow(image) {
  return `jobs:\n  e2e:\n    container:\n      image: ${image}\n`;
}

describe("checkPlaywrightImages", () => {
  it("accepts an image whose tag matches the installed Playwright version", () => {
    expect(checkPlaywrightImages({ "ci.yml": workflow("mcr.microsoft.com/playwright:v1.63.0-noble") }, "1.63.0"))
      .toEqual([]);
  });

  it("reports an image that lags behind a Playwright upgrade", () => {
    const errors = checkPlaywrightImages({ "ci.yml": workflow("mcr.microsoft.com/playwright:v1.62.1-noble") }, "1.63.0");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ci.yml");
    expect(errors[0]).toContain("v1.62.1");
    expect(errors[0]).toContain("v1.63.0");
  });

  it("rejects floating tags because browsers must match the test runner exactly", () => {
    for (const tag of ["latest", "noble", "v1-noble"]) {
      expect(checkPlaywrightImages({ "ci.yml": workflow(`mcr.microsoft.com/playwright:${tag}`) }, "1.63.0"))
        .toHaveLength(1);
    }
  });

  it("checks quoted images in every workflow file and ignores unrelated images", () => {
    const errors = checkPlaywrightImages({
      "ci.yml": workflow("\"mcr.microsoft.com/playwright:v1.63.0-noble\""),
      "release.yml": workflow("'mcr.microsoft.com/playwright:v1.60.0-jammy'"),
      "docs.yml": workflow("node:22-bookworm"),
    }, "1.63.0");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("release.yml");
  });
});

describe("repository workflows", () => {
  it("pin the Playwright image to the locked @playwright/test version", () => {
    const dir = path.join(REPO_ROOT, ".github", "workflows");
    const files = Object.fromEntries(
      fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
    );
    const version = installedPlaywrightVersion(REPO_ROOT);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.values(files).some((text) => text.includes("mcr.microsoft.com/playwright:"))).toBe(true);
    expect(checkPlaywrightImages(files, version)).toEqual([]);
  });
});
