import { describe, it, expect, vi } from "vitest";
import {
  STORAGE_KEY,
  isUsableUrl,
  getPinnedTab,
  setPinnedTab,
  clearPinnedTab,
  findFallbackTab,
  resolveTargetTab,
} from "./tab-target.mjs";

function makeStorage(initial = {}) {
  let state = { ...initial };
  return {
    get: vi.fn().mockImplementation(async (key) => {
      if (typeof key === "string") return { [key]: state[key] };
      return { ...state };
    }),
    set: vi.fn().mockImplementation(async (patch) => {
      state = { ...state, ...patch };
    }),
    _state: () => state,
  };
}

function makeDeps({ pinned = null, getTabImpl, tabsByQuery = {} } = {}) {
  const storage = makeStorage(pinned ? { [STORAGE_KEY]: pinned } : {});
  return {
    storage,
    getTab: vi.fn().mockImplementation(async (id) => {
      if (typeof getTabImpl === "function") return getTabImpl(id);
      throw new Error("not found");
    }),
    queryTabs: vi.fn().mockImplementation(async (q) => {
      if (q.lastFocusedWindow) return tabsByQuery.lastFocused || [];
      return tabsByQuery.all || [];
    }),
  };
}

describe("isUsableUrl", () => {
  it.each([
    ["https://example.com/", true],
    ["http://localhost:3000/", true],
    ["chrome://settings", false],
    ["chrome-extension://abc/popup.html", false],
    ["about:blank", false],
    ["edge://newtab", false],
    ["", false],
    [null, false],
  ])("scheme %s → %s", (url, ok) => {
    expect(isUsableUrl(url)).toBe(ok);
  });
});

describe("pin CRUD", () => {
  it("returns null when nothing is pinned", async () => {
    const s = makeStorage();
    expect(await getPinnedTab(s)).toBeNull();
  });

  it("rejects invalid tabs", async () => {
    const s = makeStorage();
    await expect(setPinnedTab(s, null)).rejects.toThrow(/invalid/);
    await expect(setPinnedTab(s, { id: "x" })).rejects.toThrow(/invalid/);
  });

  it("round-trips pin → get", async () => {
    const s = makeStorage();
    await setPinnedTab(s, { id: 42, url: "https://ratsit.se/p", title: "Profile" });
    const pin = await getPinnedTab(s);
    expect(pin.tabId).toBe(42);
    expect(pin.url).toBe("https://ratsit.se/p");
    expect(pin.host).toBe("ratsit.se");
    expect(pin.title).toBe("Profile");
    expect(pin.pinnedAt).toBeGreaterThan(0);
  });

  it("clearPinnedTab nulls the value", async () => {
    const s = makeStorage();
    await setPinnedTab(s, { id: 1, url: "https://a.test/" });
    await clearPinnedTab(s);
    expect(await getPinnedTab(s)).toBeNull();
  });

  it("ignores malformed persisted values", async () => {
    const s = makeStorage({ [STORAGE_KEY]: { tabId: "not-a-number" } });
    expect(await getPinnedTab(s)).toBeNull();
  });
});

describe("findFallbackTab", () => {
  it("prefers the active https tab in the last-focused window", async () => {
    const deps = makeDeps({
      tabsByQuery: {
        lastFocused: [
          { id: 1, url: "chrome://settings", active: false },
          { id: 2, url: "https://news.example.com/", active: false },
          { id: 3, url: "https://target.example.com/page", active: true },
        ],
      },
    });
    const t = await findFallbackTab(deps);
    expect(t.id).toBe(3);
  });

  it("falls through to all tabs when the focused window is all-chrome://", async () => {
    const deps = makeDeps({
      tabsByQuery: {
        lastFocused: [
          { id: 9, url: "chrome://extensions", active: true },
        ],
        all: [
          { id: 10, url: "https://other-window.test/", active: false },
        ],
      },
    });
    const t = await findFallbackTab(deps);
    expect(t.id).toBe(10);
  });

  it("returns null when nothing is usable anywhere", async () => {
    const deps = makeDeps({
      tabsByQuery: { lastFocused: [{ id: 1, url: "chrome://x" }], all: [{ id: 2, url: "about:blank" }] },
    });
    expect(await findFallbackTab(deps)).toBeNull();
  });
});

describe("resolveTargetTab", () => {
  it("returns the pinned tab when it exists and is usable", async () => {
    const deps = makeDeps({
      pinned: { tabId: 7, url: "https://ratsit.se/", host: "ratsit.se", title: "R", pinnedAt: 1 },
      getTabImpl: (id) => Promise.resolve({ id, url: "https://ratsit.se/", title: "R" }),
    });
    const r = await resolveTargetTab(deps);
    expect(r.source).toBe("pinned");
    expect(r.tab.id).toBe(7);
  });

  it("falls back when the pinned tab was closed (and clears the pin)", async () => {
    const deps = makeDeps({
      pinned: { tabId: 99, url: "https://gone.test/", host: "gone.test", title: "", pinnedAt: 1 },
      getTabImpl: () => Promise.reject(new Error("No tab with id")),
      tabsByQuery: {
        lastFocused: [{ id: 11, url: "https://fallback.test/", active: true }],
      },
    });
    const r = await resolveTargetTab(deps);
    expect(r.source).toBe("active");
    expect(r.tab.id).toBe(11);
    // Pin was cleared as a side effect.
    expect(await getPinnedTab(deps.storage)).toBeNull();
  });

  it("returns a reason when the pinned tab is on an unusable URL", async () => {
    const deps = makeDeps({
      pinned: { tabId: 7, url: "https://ratsit.se/", host: "ratsit.se", title: "", pinnedAt: 1 },
      getTabImpl: (id) => Promise.resolve({ id, url: "chrome://settings/", title: "" }),
    });
    const r = await resolveTargetTab(deps);
    expect(r.source).toBe("none");
    expect(r.reason).toMatch(/navigated/);
  });

  it("returns the highest-scored fallback when no pin is set", async () => {
    const deps = makeDeps({
      tabsByQuery: {
        lastFocused: [
          { id: 1, url: "https://a.test/", active: false },
          { id: 2, url: "https://b.test/", active: true },
        ],
      },
    });
    const r = await resolveTargetTab(deps);
    expect(r.source).toBe("active");
    expect(r.tab.id).toBe(2);
  });

  it("reports a clear reason when no usable tab exists at all", async () => {
    const deps = makeDeps({ tabsByQuery: { lastFocused: [], all: [] } });
    const r = await resolveTargetTab(deps);
    expect(r.source).toBe("none");
    expect(r.tab).toBeNull();
    expect(r.reason).toMatch(/no usable/);
  });

  it("prefers the foreground-tracker tab over the live fallback", async () => {
    const fgTab = { id: 33, url: "https://foreground.test/", active: false };
    const liveTab = { id: 99, url: "https://stale.test/", active: true };
    const deps = makeDeps({
      getTabImpl: (id) => Promise.resolve(id === 33 ? fgTab : liveTab),
      tabsByQuery: { lastFocused: [liveTab] },
    });
    deps.getForegroundTab = vi.fn().mockResolvedValue({ tabId: 33, url: "https://foreground.test/" });
    const r = await resolveTargetTab(deps);
    expect(r.source).toBe("foreground");
    expect(r.tab.id).toBe(33);
  });

  it("falls back to the live query when the tracked foreground tab is gone", async () => {
    const liveTab = { id: 99, url: "https://stale.test/", active: true };
    const deps = makeDeps({
      getTabImpl: () => Promise.reject(new Error("No tab with id 33")),
      tabsByQuery: { lastFocused: [liveTab] },
    });
    deps.getForegroundTab = vi.fn().mockResolvedValue({ tabId: 33, url: "https://foreground.test/" });
    const r = await resolveTargetTab(deps);
    expect(r.source).toBe("active");
    expect(r.tab.id).toBe(99);
  });

  it("ignores a tracked foreground tab whose URL turned unusable", async () => {
    const liveTab = { id: 99, url: "https://stale.test/", active: true };
    const deps = makeDeps({
      getTabImpl: (id) =>
        Promise.resolve(id === 33 ? { id: 33, url: "chrome://settings/" } : liveTab),
      tabsByQuery: { lastFocused: [liveTab] },
    });
    deps.getForegroundTab = vi.fn().mockResolvedValue({ tabId: 33, url: "chrome://settings/" });
    const r = await resolveTargetTab(deps);
    expect(r.source).toBe("active");
    expect(r.tab.id).toBe(99);
  });
});
