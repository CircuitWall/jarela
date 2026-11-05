import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeModulesOverlay, resolveBrandConfig } from "./build-branded-app.mjs";

const temporaryDirectories = [];

function createBrandDirectory(config, assets = {}) {
  const directory = mkdtempSync(join(tmpdir(), "jarela-brand-test-"));
  temporaryDirectories.push(directory);
  for (const [path, contents] of Object.entries(assets)) {
    const assetPath = join(directory, path);
    mkdirSync(join(assetPath, ".."), { recursive: true });
    writeFileSync(assetPath, contents);
  }
  const configPath = join(directory, "brand.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { directory, configPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveBrandConfig", () => {
  it("resolves defaults, placeholders, and local asset URLs", () => {
    const { configPath } = createBrandDirectory({
      name: "Acme Assistant",
      systemName: "Acme",
      assistantIdentity: "You are {{assistantName}} in {{systemName}}.",
      description: "Welcome to {{appName}}.",
      assets: {
        logoLight: "brand/logo.svg",
        icon192: "brand/icon.png",
      },
    }, {
      "brand/logo.svg": "<svg />",
      "brand/icon.png": "png",
    });

    expect(resolveBrandConfig(configPath)).toEqual({
      name: "Acme Assistant",
      env: {
        NEXT_PUBLIC_APP_NAME: "Acme Assistant",
        NEXT_PUBLIC_APP_SHORT_NAME: "Acme Assistant",
        NEXT_PUBLIC_APP_DESCRIPTION: "Welcome to Acme Assistant.",
        NEXT_PUBLIC_SYSTEM_NAME: "Acme",
        NEXT_PUBLIC_APP_ASSISTANT_NAME: "Acme Assistant",
        NEXT_PUBLIC_APP_ASSISTANT_IDENTITY: "You are Acme Assistant in Acme.",
        NEXT_PUBLIC_APP_LOGO_LIGHT: "/branding/logoLight.svg",
        NEXT_PUBLIC_APP_ICON_192: "/branding/icon192.png",
      },
      assets: [
        expect.objectContaining({ key: "logoLight", destination: "/branding/logoLight.svg" }),
        expect.objectContaining({ key: "icon192", destination: "/branding/icon192.png" }),
      ],
    });
  });

  it("uses explicit optional values and validates web issue URLs and colors", () => {
    const { configPath } = createBrandDirectory({
      name: "Acme",
      shortName: "AC",
      assistantName: "Nova",
      description: "Acme desktop",
      issueUrl: "https://example.com/issues",
      accentColor: "#abc",
      accentHoverColor: "#123456",
    });

    expect(resolveBrandConfig(configPath).env).toMatchObject({
      NEXT_PUBLIC_APP_SHORT_NAME: "AC",
      NEXT_PUBLIC_APP_ASSISTANT_NAME: "Nova",
      NEXT_PUBLIC_APP_ISSUE_URL: "https://example.com/issues",
      NEXT_PUBLIC_APP_ACCENT_COLOR: "#abc",
      NEXT_PUBLIC_APP_ACCENT_HOVER_COLOR: "#123456",
    });
  });

  it("rejects unknown fields and asset keys", () => {
    const { configPath } = createBrandDirectory({ name: "Acme", unexpected: true });
    expect(() => resolveBrandConfig(configPath)).toThrow(/unexpected/);

    const invalidAssetKey = createBrandDirectory({
      name: "Acme",
      assets: { logo: "logo.png" },
    }, { "logo.png": "png" });
    expect(() => resolveBrandConfig(invalidAssetKey.configPath)).toThrow(/unknown key/);
  });

  it("rejects unsupported placeholders, unsafe paths, and invalid protocols", () => {
    const placeholder = createBrandDirectory({
      name: "Acme",
      assistantIdentity: "Hello {{unknown}}",
    });
    expect(() => resolveBrandConfig(placeholder.configPath)).toThrow(/unsupported placeholder/);

    const path = createBrandDirectory({
      name: "Acme",
      assets: { logoLight: "../outside.png" },
    });
    expect(() => resolveBrandConfig(path.configPath)).toThrow(/remain inside/);

    const protocol = createBrandDirectory({ name: "Acme", issueUrl: "file:///tmp/issues" });
    expect(() => resolveBrandConfig(protocol.configPath)).toThrow(/HTTP or HTTPS/);
  });

  it("rejects missing, non-image, and oversized assets", () => {
    const missing = createBrandDirectory({ name: "Acme", assets: { logoLight: "missing.svg" } });
    expect(() => resolveBrandConfig(missing.configPath)).toThrow();

    const unsupported = createBrandDirectory({
      name: "Acme",
      assets: { logoLight: "logo.gif" },
    }, { "logo.gif": "gif" });
    expect(() => resolveBrandConfig(unsupported.configPath)).toThrow(/SVG, ICO, JPEG, PNG, or WebP/);

    const oversized = createBrandDirectory({ name: "Acme", assets: { icon192: "icon.png" } });
    const oversizedPath = join(oversized.directory, "icon.png");
    writeFileSync(oversizedPath, "");
    truncateSync(oversizedPath, 10 * 1024 * 1024 + 1);
    expect(() => resolveBrandConfig(oversized.configPath)).toThrow(/10 MB limit/);
  });

  it("requires icon assets to match their declared MIME types", () => {
    const mismatchedAssets = [
      ["faviconSvg", "favicon.png", "png", ".svg"],
      ["faviconIco", "favicon.svg", "svg", ".ico"],
      ["icon192", "icon.webp", "webp", ".png"],
      ["icon512Maskable", "icon.jpg", "jpg", ".png"],
      ["appleTouchIcon", "apple.webp", "webp", ".png"],
    ];

    for (const [key, path, contents, expectedExtension] of mismatchedAssets) {
      const { configPath } = createBrandDirectory({
        name: "Acme",
        assets: { [key]: path },
      }, { [path]: contents });

      expect(() => resolveBrandConfig(configPath)).toThrow(
        new RegExp(`${key} must use ${expectedExtension}`),
      );
    }
  });
});

describe("createNodeModulesOverlay", () => {
  it("preserves nested dependency priority and includes hoisted packages", () => {
    const root = mkdtempSync(join(tmpdir(), "jarela-modules-test-"));
    temporaryDirectories.push(root);
    const nestedModules = join(root, "package", "node_modules");
    const hoistedModules = join(root, "consumer", "node_modules");
    const destination = join(root, "staging", "node_modules");
    const nestedNext = join(nestedModules, "next");
    const hoistedNext = join(hoistedModules, "next");
    const nestedTypescript = join(nestedModules, "typescript");
    const nestedSerwistUtils = join(nestedModules, "@serwist", "utils");
    const hoistedSerwist = join(hoistedModules, "@serwist", "next");

    mkdirSync(nestedNext, { recursive: true });
    mkdirSync(hoistedNext, { recursive: true });
    mkdirSync(nestedTypescript, { recursive: true });
    mkdirSync(nestedSerwistUtils, { recursive: true });
    mkdirSync(hoistedSerwist, { recursive: true });
    createNodeModulesOverlay([nestedModules, hoistedModules], destination);

    expect(realpathSync(join(destination, "next"))).toBe(realpathSync(nestedNext));
    expect(realpathSync(join(destination, "typescript"))).toBe(realpathSync(nestedTypescript));
    expect(realpathSync(join(destination, "@serwist", "utils"))).toBe(realpathSync(nestedSerwistUtils));
    expect(realpathSync(join(destination, "@serwist", "next"))).toBe(realpathSync(hoistedSerwist));
  });
});
