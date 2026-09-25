import { gunzipSync } from "node:zlib";

// Some provider proxies return gzip bytes without Content-Encoding. Node's
// fetch can only transparently decode correctly labelled responses, so probe
// calls need this guard before treating a successful body as JSON.
export async function readJsonResponse<T>(res: Response): Promise<T> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = isGzip
    ? gunzipSync(bytes).toString("utf8")
    : new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}