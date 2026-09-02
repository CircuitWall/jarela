import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest } from "./app-manifest";

const KEYS = [
  "NEXT_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_APP_SHORT_NAME",
  "NEXT_PUBLIC_APP_DESCRIPTION",
  "NEXT_PUBLIC_APP_ICON_192",
] as const;

describe("buildManifest", () => {
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

  // Guards against drift from the public/manifest.json this replaced.
  it("reproduces the upstream manifest when no brand overrides are set", () => {
    const m = buildManifest();
    expect(m.name).toBe("Jarela");
    expect(m.short_name).toBe("Jarela");
    expect(m.description).toBe("Jarela — local chat interface for LangGraph agents");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.display_override).toEqual(["minimal-ui", "standalone"]);
    expect(m.background_color).toBe("#09090b");
    expect(m.theme_color).toBe("#09090b");
    expect(m.icons?.map((i) => i.src)).toEqual([
      "/icon-192.png",
      "/icon-192-maskable.png",
      "/icon-512.png",
      "/icon-512-maskable.png",
      "/icon-192-light.png",
      "/icon-192-maskable-light.png",
      "/icon-512-light.png",
      "/icon-512-maskable-light.png",
      "/apple-touch-icon.png",
    ]);
  });

  it("keeps the Edge side-panel hint the static manifest carried", () => {
    const m = buildManifest() as unknown as Record<string, unknown>;
    expect(m.edge_side_panel).toEqual({ preferred_width: 480 });
  });

  it("follows the brand overrides", () => {
    process.env.NEXT_PUBLIC_APP_NAME = "MyFork";
    process.env.NEXT_PUBLIC_APP_SHORT_NAME = "Fork";
    process.env.NEXT_PUBLIC_APP_DESCRIPTION = "MyFork — internal build";
    process.env.NEXT_PUBLIC_APP_ICON_192 = "/brand/i192.png";

    const m = buildManifest();
    expect(m.name).toBe("MyFork");
    expect(m.short_name).toBe("Fork");
    expect(m.description).toBe("MyFork — internal build");
    expect(m.icons?.[0]?.src).toBe("/brand/i192.png");
  });
});
