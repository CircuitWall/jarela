import { describe, it, expect, vi } from "vitest";
import { withSqliteRetry, isBusyError } from "./retry";

describe("isBusyError", () => {
  it("recognises SQLITE_BUSY by code", () => {
    expect(isBusyError({ code: "SQLITE_BUSY" })).toBe(true);
  });

  it("recognises SQLITE_LOCKED by code", () => {
    expect(isBusyError({ code: "SQLITE_LOCKED" })).toBe(true);
  });

  it("recognises SQLITE_BUSY in message text (node:sqlite shape)", () => {
    expect(isBusyError({ message: "SQLITE_BUSY: database is locked" })).toBe(true);
  });

  it("does NOT match other SQLITE errors", () => {
    expect(isBusyError({ code: "SQLITE_CORRUPT" })).toBe(false);
    expect(isBusyError({ code: "SQLITE_READONLY" })).toBe(false);
    expect(isBusyError({ message: "SQLITE_IOERR" })).toBe(false);
  });

  it("does not match non-objects or non-DB errors", () => {
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
    expect(isBusyError("plain string")).toBe(false);
    expect(isBusyError(new Error("network failure"))).toBe(false);
  });
});

describe("withSqliteRetry", () => {
  it("returns the value when fn succeeds on first try", () => {
    const fn = vi.fn(() => 42);
    expect(withSqliteRetry(fn)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on SQLITE_BUSY and eventually succeeds", () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      if (calls < 3) {
        const e = new Error("locked");
        (e as Error & { code: string }).code = "SQLITE_BUSY";
        throw e;
      }
      return "ok";
    });
    expect(withSqliteRetry(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows the last BUSY error after exhausting retries", () => {
    const err = new Error("locked");
    (err as Error & { code: string }).code = "SQLITE_BUSY";
    const fn = vi.fn(() => { throw err; });
    expect(() => withSqliteRetry(fn)).toThrow("locked");
    // Initial attempt + 3 retries.
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("does NOT retry non-BUSY errors", () => {
    const err = new Error("constraint failed");
    (err as Error & { code: string }).code = "SQLITE_CONSTRAINT";
    const fn = vi.fn(() => { throw err; });
    expect(() => withSqliteRetry(fn)).toThrow("constraint failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propagates plain JS errors unchanged", () => {
    const fn = vi.fn(() => { throw new TypeError("not a function"); });
    expect(() => withSqliteRetry(fn)).toThrow(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
