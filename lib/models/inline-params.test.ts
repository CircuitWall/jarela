import { describe, expect, it } from "vitest";
import { preserveInlineModelSecrets, redactInlineModelParams } from "./inline-params";

const fields = ["api_key", "client_secret", "refresh_token", "access_token"] as const;

describe("inline model parameters", () => {
  it.each(fields)("redacts %s without changing non-secret, empty or non-string values", (field) => {
    expect(redactInlineModelParams(JSON.stringify({ [field]: "synthetic-secret", temperature: 0.4 })))
      .toEqual({ [field]: "***", temperature: 0.4 });
    for (const value of ["", null, false, 0]) {
      expect(redactInlineModelParams(JSON.stringify({ [field]: value }))).toEqual({ [field]: value });
    }
  });

  it("retains the existing malformed-JSON fallback and rejects a persisted null object", () => {
    expect(redactInlineModelParams("{")).toEqual({});
    expect(() => redactInlineModelParams("null")).toThrow(TypeError);
  });

  it.each(fields)("preserves echoed masks for %s without mutating incoming parameters", (field) => {
    for (const mask of ["***", "********"]) {
      const incoming = { [field]: mask, temperature: 0.4 };
      expect(preserveInlineModelSecrets(incoming, JSON.stringify({ [field]: "synthetic-secret", omitted: true })))
        .toEqual({ [field]: "synthetic-secret", temperature: 0.4 });
      expect(incoming[field]).toBe(mask);
    }
  });

  it.each(fields)("omits an echoed %s mask when there is no usable prior secret", (field) => {
    for (const existing of [{}, { [field]: "" }, { [field]: null }, { [field]: 0 }]) {
      expect(preserveInlineModelSecrets({ [field]: "***" }, JSON.stringify(existing))).toEqual({});
    }
    expect(preserveInlineModelSecrets({ [field]: "********" }, "{")).toEqual({});
  });

  it("does not merge omitted values or replace explicitly supplied clears and new values", () => {
    const incoming = { api_key: "", client_secret: null, refresh_token: "synthetic-new", non_secret: "***" };
    expect(preserveInlineModelSecrets(incoming, JSON.stringify({
      api_key: "synthetic-old", client_secret: "synthetic-old", access_token: "synthetic-old",
    }))).toEqual(incoming);
  });

  it("keeps missing-row upsert behavior and distinguishes an empty persisted value", () => {
    const incoming = { api_key: "***" };
    expect(preserveInlineModelSecrets(incoming, undefined)).toBe(incoming);
    expect(preserveInlineModelSecrets(incoming, "")).toEqual({});
  });
});
