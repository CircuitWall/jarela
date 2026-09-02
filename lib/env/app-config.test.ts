import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UPSTREAM_NAME,
  UPSTREAM_URL,
  getAppAccentColor,
  getAppAccentHoverColor,
  getAppDescription,
  getAppIcons,
  getAppIssueUrl,
  getAppLogoDark,
  getAppLogoLight,
  getAppName,
  getAppShortName,
} from "./app-config";

const KEYS = [
  "NEXT_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_APP_SHORT_NAME",
  "NEXT_PUBLIC_APP_DESCRIPTION",
  "NEXT_PUBLIC_APP_ISSUE_URL",
  "NEXT_PUBLIC_APP_LOGO_LIGHT",
  "NEXT_PUBLIC_APP_LOGO_DARK",
  "NEXT_PUBLIC_APP_FAVICON_SVG",
  "NEXT_PUBLIC_APP_FAVICON_ICO",
  "NEXT_PUBLIC_APP_ICON_192",
  "NEXT_PUBLIC_APP_ICON_512",
  "NEXT_PUBLIC_APP_ICON_192_MASKABLE",
  "NEXT_PUBLIC_APP_ICON_512_MASKABLE",
  "NEXT_PUBLIC_APP_ICON_192_LIGHT",
  "NEXT_PUBLIC_APP_ICON_512_LIGHT",
  "NEXT_PUBLIC_APP_ICON_192_MASKABLE_LIGHT",
  "NEXT_PUBLIC_APP_ICON_512_MASKABLE_LIGHT",
  "NEXT_PUBLIC_APP_APPLE_TOUCH_ICON",
  "NEXT_PUBLIC_APP_ACCENT_COLOR",
  "NEXT_PUBLIC_APP_ACCENT_HOVER_COLOR",
] as const;

describe("app-config", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe("getAppName", () => {
    it("defaults to 'Jarela' when env var is unset", () => {
      expect(getAppName()).toBe("Jarela");
    });

    it("returns the env value when set", () => {
      process.env.NEXT_PUBLIC_APP_NAME = "MyFork";
      expect(getAppName()).toBe("MyFork");
    });

    it("trims whitespace", () => {
      process.env.NEXT_PUBLIC_APP_NAME = "  MyFork  ";
      expect(getAppName()).toBe("MyFork");
    });

    it("falls back to default when env value is empty / whitespace-only", () => {
      process.env.NEXT_PUBLIC_APP_NAME = "";
      expect(getAppName()).toBe("Jarela");
      process.env.NEXT_PUBLIC_APP_NAME = "   ";
      expect(getAppName()).toBe("Jarela");
    });
  });

  describe("getAppDescription", () => {
    it("defaults to the upstream description", () => {
      expect(getAppDescription()).toBe(
        "Jarela — local chat interface for LangGraph agents",
      );
    });

    it("returns the env value when set", () => {
      process.env.NEXT_PUBLIC_APP_DESCRIPTION = "MyFork — internal fork";
      expect(getAppDescription()).toBe("MyFork — internal fork");
    });

    it("falls back to default when env value is empty", () => {
      process.env.NEXT_PUBLIC_APP_DESCRIPTION = "  ";
      expect(getAppDescription()).toBe(
        "Jarela — local chat interface for LangGraph agents",
      );
    });
  });

  describe("getAppIssueUrl", () => {
    it("defaults to the upstream GitHub issue URL", () => {
      expect(getAppIssueUrl()).toBe(
        "https://github.com/CircuitWall/jarela/issues/new",
      );
    });

    it("returns the env value when set", () => {
      process.env.NEXT_PUBLIC_APP_ISSUE_URL = "https://example.com/bugs";
      expect(getAppIssueUrl()).toBe("https://example.com/bugs");
    });

    it("falls back to default when env value is empty", () => {
      process.env.NEXT_PUBLIC_APP_ISSUE_URL = "";
      expect(getAppIssueUrl()).toBe(
        "https://github.com/CircuitWall/jarela/issues/new",
      );
    });
  });

  describe("getAppShortName", () => {
    it("defaults to the app name", () => {
      expect(getAppShortName()).toBe("Jarela");
      process.env.NEXT_PUBLIC_APP_NAME = "MyFork";
      expect(getAppShortName()).toBe("MyFork");
    });

    it("prefers an explicit short name", () => {
      process.env.NEXT_PUBLIC_APP_NAME = "My Very Long Fork Name";
      process.env.NEXT_PUBLIC_APP_SHORT_NAME = "Fork";
      expect(getAppShortName()).toBe("Fork");
    });
  });

  describe("logo overrides", () => {
    it("defaults to the shipped marks", () => {
      expect(getAppLogoLight()).toBe("/logo-mark-transparent.png");
      expect(getAppLogoDark()).toBe("/logo-mark-transparent-dark.png");
    });

    it("returns env values when set", () => {
      process.env.NEXT_PUBLIC_APP_LOGO_LIGHT = "/brand/light.png";
      process.env.NEXT_PUBLIC_APP_LOGO_DARK = "/brand/dark.png";
      expect(getAppLogoLight()).toBe("/brand/light.png");
      expect(getAppLogoDark()).toBe("/brand/dark.png");
    });

    it("falls the dark mark back to the light one for single-asset forks", () => {
      process.env.NEXT_PUBLIC_APP_LOGO_LIGHT = "/brand/only.png";
      expect(getAppLogoDark()).toBe("/brand/only.png");
    });
  });

  describe("getAppIcons", () => {
    it("defaults to the shipped icon set", () => {
      expect(getAppIcons()).toEqual({
        faviconSvg: "/favicon.svg",
        faviconIco: "/favicon.ico",
        icon192: "/icon-192.png",
        icon512: "/icon-512.png",
        icon192Maskable: "/icon-192-maskable.png",
        icon512Maskable: "/icon-512-maskable.png",
        icon192Light: "/icon-192-light.png",
        icon512Light: "/icon-512-light.png",
        icon192MaskableLight: "/icon-192-maskable-light.png",
        icon512MaskableLight: "/icon-512-maskable-light.png",
        appleTouchIcon: "/apple-touch-icon.png",
      });
    });

    it("overrides individual entries", () => {
      process.env.NEXT_PUBLIC_APP_ICON_192 = "https://cdn.example.com/i192.png";
      expect(getAppIcons().icon192).toBe("https://cdn.example.com/i192.png");
      // Untouched entries keep their defaults.
      expect(getAppIcons().icon512).toBe("/icon-512.png");
    });
  });

  describe("accent color", () => {
    it("returns null when unset", () => {
      expect(getAppAccentColor()).toBeNull();
      expect(getAppAccentHoverColor()).toBeNull();
    });

    it("accepts 3- and 6-digit hex", () => {
      process.env.NEXT_PUBLIC_APP_ACCENT_COLOR = "#0aF";
      expect(getAppAccentColor()).toBe("#0aF");
      process.env.NEXT_PUBLIC_APP_ACCENT_COLOR = "#12ab34";
      expect(getAppAccentColor()).toBe("#12ab34");
    });

    it("rejects non-hex values so nothing unescaped reaches the stylesheet", () => {
      for (const bad of ["red", "rgb(1,2,3)", "#12345", "}html{display:none", "#12ab34;"]) {
        process.env.NEXT_PUBLIC_APP_ACCENT_COLOR = bad;
        expect(getAppAccentColor()).toBeNull();
      }
    });

    it("derives a darker hover shade from the accent", () => {
      process.env.NEXT_PUBLIC_APP_ACCENT_COLOR = "#646464";
      // 0x64 = 100 -> round(100 * 0.85) = 85 = 0x55
      expect(getAppAccentHoverColor()).toBe("#555555");
    });

    it("expands 3-digit accents before deriving the hover shade", () => {
      process.env.NEXT_PUBLIC_APP_ACCENT_COLOR = "#666";
      // 0x66 = 102 -> round(102 * 0.85) = 87 = 0x57
      expect(getAppAccentHoverColor()).toBe("#575757");
    });

    it("prefers an explicit hover color", () => {
      process.env.NEXT_PUBLIC_APP_ACCENT_COLOR = "#646464";
      process.env.NEXT_PUBLIC_APP_ACCENT_HOVER_COLOR = "#010203";
      expect(getAppAccentHoverColor()).toBe("#010203");
    });

    it("ignores a hover color set without an accent", () => {
      process.env.NEXT_PUBLIC_APP_ACCENT_HOVER_COLOR = "#010203";
      expect(getAppAccentHoverColor()).toBe("#010203");
      expect(getAppAccentColor()).toBeNull();
    });
  });

  describe("upstream identity", () => {
    it("is not overridable by any brand env var", () => {
      process.env.NEXT_PUBLIC_APP_NAME = "MyFork";
      process.env.NEXT_PUBLIC_APP_ISSUE_URL = "https://example.com/bugs";
      expect(UPSTREAM_NAME).toBe("Jarela");
      expect(UPSTREAM_URL).toBe("https://github.com/CircuitWall/jarela");
    });
  });
});
