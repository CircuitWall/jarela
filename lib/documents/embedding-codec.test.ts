import { describe, expect, it } from "vitest";
import { decodeEmbedding, encodeEmbedding, isLegacyEmbedding } from "./embedding-codec";

describe("document embedding codec", () => {
  it("round-trips float32 vectors through a BLOB", () => {
    const vector = [0, 0.5, -1.25, 3.14159, 1e-7];
    const encoded = encodeEmbedding(vector);

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.byteLength).toBe(vector.length * 4);
    expect(decodeEmbedding(encoded)).toEqual(vector.map((value) => Math.fround(value)));
  });

  it("decodes legacy JSON text and rejects malformed values", () => {
    expect(isLegacyEmbedding("[1,0.5]")).toBe(true);
    expect(decodeEmbedding("[1,0.5]")).toEqual([1, 0.5]);
    expect(decodeEmbedding('{"not":"an array"}')).toBeNull();
    expect(decodeEmbedding("not json")).toBeNull();
    expect(decodeEmbedding("[1,null]")).toBeNull();
    expect(decodeEmbedding(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodeEmbedding(null)).toBeNull();
  });

  it("rejects non-finite float32 components", () => {
    const encoded = encodeEmbedding([Number.NaN]);
    expect(decodeEmbedding(encoded)).toBeNull();
  });
});
