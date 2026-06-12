import { describe, it, expect, vi } from "vitest";
import {
  FOREGROUND_STORAGE_KEY,
  getForegroundTab,
  recordForegroundTab,
  clearForegroundTab,
  handleTabActivated,
  handleTabUpdated,
  handleWindowFocused,
  handleTabRemoved,
  seedForegroundTab,
} from "./foreground-tab.mjs";

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

function makeDeps({ tabs = [], byId = {} } = {}) {
  return {
    storage: makeStorage(),
    getTab: vi.fn().mockImplementation(async (id) => {
      if (byId[id] !== undefined) return byId[id];
      throw new Error("No tab with id " + id);
    }),
    queryTabs: vi.fn().mockImplementation(async (q) => {
      if (q.windowId !== undefined) return tabs.filter((t) => t.windowId === q.windowId && t.active);
      if (q.lastFocusedWindow) return tabs.filter((t) => t.active && t.lastFocusedWindow);
      if (q.active) return tabs.filter((t) => t.active);
      return tabs;
    }),
  };
}

describe("getForegroundTab / recordForegroundTab", () => {
  it("returns null when nothing is recorded", async () => {
    const s = makeStorage();
    expect(await getForegroundTab(s)).toBeNull();
  });

  it("records and reads back a usable tab", async () => {
    const s = makeStorage();
    const ok = await recordForegroundTab(s, {
      id: 7,
      windowId: 1,
      url: "https://example.com/",
      title: "Example",
    });
    expect(ok).toBe(true);
    const fg = await getForegroundTab(s);
    expect(fg.tabId).toBe(7);
    expect(fg.url).toBe("https://example.com/");
    expect(fg.host).toBe("example.com");
    expect(fg.windowId).toBe(1);
    expect(fg.recordedAt).toBeGreaterThan(0);
  });

  it("refuses to record tabs on unusable URLs", async () => {
    const s = makeStorage();
    expect(await recordForegroundTab(s, { id: 1, url: "chrome://settings/" })).toBe(false);
    expect(await recordForegroundTab(s, { id: 2, url: "about:blank" })).toBe(false);
    expect(await recordForegroundTab(s, { id: 3, url: "" })).toBe(false);
    expect(await getForegroundTab(s)).toBeNull();
  });

  it("clears the record on demand", async () => {
    const s = makeStorage();
    await recordForegroundTab(s, { id: 7, url: "https://x.com/" });
    await clearForegroundTab(s);
    expect(await getForegroundTab(s)).toBeNull();
  });
});

describe("handleTabActivated", () => {
  it("records the activated tab when usable", async () => {
    const deps = makeDeps({ byId: { 5: { id: 5, url: "https://x.com/", windowId: 1 } } });
    expect(await handleTabActivated(deps, { tabId: 5 })).toBe(true);
    expect((await getForegroundTab(deps.storage)).tabId).toBe(5);
  });

  it("ignores activation of unusable tabs", async () => {
    const deps = makeDeps({ byId: { 5: { id: 5, url: "chrome://settings/" } } });
    expect(await handleTabActivated(deps, { tabId: 5 })).toBe(false);
    expect(await getForegroundTab(deps.storage)).toBeNull();
  });

  it("swallows getTab errors", async () => {
    const deps = makeDeps({});
    expect(await handleTabActivated(deps, { tabId: 99 })).toBe(false);
  });
});

describe("handleTabUpdated", () => {
  it("records the active tab when its load completes on a usable URL", async () => {
    const deps = makeDeps({});
    const ok = await handleTabUpdated(
      deps,
      5,
      { status: "complete" },
      { id: 5, active: true, url: "https://x.com/", windowId: 1 },
    );
    expect(ok).toBe(true);
  });

  it("ignores updates of inactive tabs", async () => {
    const deps = makeDeps({});
    const ok = await handleTabUpdated(
      deps,
      5,
      { status: "complete" },
      { id: 5, active: false, url: "https://x.com/" },
    );
    expect(ok).toBe(false);
  });

  it("records on a URL change even when status is still loading", async () => {
    const deps = makeDeps({});
    const ok = await handleTabUpdated(
      deps,
      5,
      { url: "https://x.com/page2" },
      { id: 5, active: true, url: "https://x.com/page2", windowId: 1 },
    );
    expect(ok).toBe(true);
  });
});

describe("handleWindowFocused", () => {
  it("records the active tab in the newly focused window", async () => {
    const deps = makeDeps({
      tabs: [
        { id: 11, active: true, windowId: 7, url: "https://focused.test/" },
        { id: 12, active: true, windowId: 8, url: "https://other.test/" },
      ],
    });
    expect(await handleWindowFocused(deps, 7)).toBe(true);
    expect((await getForegroundTab(deps.storage)).tabId).toBe(11);
  });

  it("ignores WINDOW_ID_NONE (-1)", async () => {
    const deps = makeDeps({});
    expect(await handleWindowFocused(deps, -1)).toBe(false);
  });

  it("returns false when the focused window has no usable active tab", async () => {
    const deps = makeDeps({
      tabs: [{ id: 11, active: true, windowId: 7, url: "chrome://settings/" }],
    });
    expect(await handleWindowFocused(deps, 7)).toBe(false);
  });
});

describe("handleTabRemoved", () => {
  it("clears the foreground record when the tracked tab is the one removed", async () => {
    const deps = makeDeps({});
    await recordForegroundTab(deps.storage, { id: 5, url: "https://x.com/" });
    expect(await handleTabRemoved(deps, 5)).toBe(true);
    expect(await getForegroundTab(deps.storage)).toBeNull();
  });

  it("leaves the record alone when a different tab is removed", async () => {
    const deps = makeDeps({});
    await recordForegroundTab(deps.storage, { id: 5, url: "https://x.com/" });
    expect(await handleTabRemoved(deps, 6)).toBe(false);
    expect((await getForegroundTab(deps.storage)).tabId).toBe(5);
  });
});

describe("seedForegroundTab", () => {
  it("seeds from the active tab in the last-focused window", async () => {
    const deps = makeDeps({
      tabs: [
        { id: 11, active: true, lastFocusedWindow: true, url: "https://seed.test/" },
      ],
    });
    expect(await seedForegroundTab(deps)).toBe(true);
    expect((await getForegroundTab(deps.storage)).tabId).toBe(11);
  });

  it("falls back to any active tab when lastFocusedWindow has nothing usable", async () => {
    const deps = makeDeps({
      tabs: [{ id: 22, active: true, url: "https://anywhere.test/" }],
    });
    expect(await seedForegroundTab(deps)).toBe(true);
    expect((await getForegroundTab(deps.storage)).tabId).toBe(22);
  });

  it("returns false when no usable active tab exists anywhere", async () => {
    const deps = makeDeps({
      tabs: [{ id: 22, active: true, url: "chrome://settings/" }],
    });
    expect(await seedForegroundTab(deps)).toBe(false);
  });
});

describe("storage key constant", () => {
  it("is the agreed-upon namespaced key", () => {
    expect(FOREGROUND_STORAGE_KEY).toBe("jarelaForegroundTab");
  });
});
