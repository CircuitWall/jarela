// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBrowserValue, removeBrowserValue, writeBrowserValue } from "./browser-store";

const KEY = "jarela:test:browser-store";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("browser value store", () => {
  it("round-trips and removes values", () => {
    writeBrowserValue(KEY, "value");
    expect(readBrowserValue(KEY)).toBe("value");
    removeBrowserValue(KEY);
    expect(readBrowserValue(KEY)).toBeNull();
  });

  it("returns null when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readBrowserValue(KEY)).toBeNull();
  });

  it("swallows write and remove failures", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeBrowserValue(KEY, "value")).not.toThrow();
    expect(() => removeBrowserValue(KEY)).not.toThrow();
  });
});
