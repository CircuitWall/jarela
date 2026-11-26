// Document-chunk embedding storage (ADR-0134).
//
// Embeddings are stored as little-endian float32 BLOBs. The previous format
// was JSON decimal text: a 384-dimension vector took ~8.0 KB instead of 1.5 KB,
// and search parsed that text on every scored row. `decodeEmbedding` still
// accepts the JSON text so existing rows remain searchable until the explicit
// rewrite action converts them.

export type StoredEmbedding = string | Uint8Array | null;

/** True for rows still stored in the legacy JSON-text format. */
export function isLegacyEmbedding(value: StoredEmbedding): value is string {
  return typeof value === "string";
}

export function encodeEmbedding(vector: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < vector.length; index += 1) {
    view.setFloat32(index * 4, vector[index], true);
  }
  return bytes;
}

export function decodeEmbedding(value: StoredEmbedding): number[] | null {
  if (value === null) return null;
  if (typeof value === "string") return decodeLegacyJson(value);
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength % 4 !== 0) {
    return null;
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const vector = new Array<number>(value.byteLength / 4);
  for (let index = 0; index < vector.length; index += 1) {
    const component = view.getFloat32(index * 4, true);
    if (!Number.isFinite(component)) return null;
    vector[index] = component;
  }
  return vector;
}

function decodeLegacyJson(value: string): number[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((component) => typeof component === "number" && Number.isFinite(component))) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
