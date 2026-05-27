import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAppName, getAppDescription, getAppIssueUrl } from "./app-config";

const KEYS = [
  "NEXT_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_APP_DESCRIPTION",
  "NEXT_PUBLIC_APP_ISSUE_URL",
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
      process.env.NEXT_PUBLIC_APP_NAME = "vClaw";
      expect(getAppName()).toBe("vClaw");
    });

    it("trims whitespace", () => {
      process.env.NEXT_PUBLIC_APP_NAME = "  vClaw  ";
      expect(getAppName()).toBe("vClaw");
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
      process.env.NEXT_PUBLIC_APP_DESCRIPTION = "vClaw — Visa fork";
      expect(getAppDescription()).toBe("vClaw — Visa fork");
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
});
