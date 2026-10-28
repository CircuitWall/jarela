import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readJsonResponse, readResponseTextCapped } from "./http-json";

describe("readJsonResponse", () => {
  it("parses ordinary JSON responses", async () => {
    await expect(readJsonResponse<{ ok: boolean }>(new Response('{"ok":true}')))
      .resolves.toEqual({ ok: true });
  });

  it("decodes gzip JSON when content-encoding is missing", async () => {
    const body = gzipSync(Buffer.from('{"ok":true}'));
    await expect(readJsonResponse<{ ok: boolean }>(new Response(body)))
      .resolves.toEqual({ ok: true });
  });

  it("detects gzip when the signature is split across stream chunks", async () => {
    const body = gzipSync(Buffer.from('{"ok":true}'));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of body) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    await expect(readJsonResponse<{ ok: boolean }>(new Response(stream)))
      .resolves.toEqual({ ok: true });
  });

  it("caps decoded gzip text rather than compressed input bytes", async () => {
    const body = gzipSync(Buffer.from("decoded response body"));
    const result = await readResponseTextCapped(new Response(body), 7);
    expect(result).toEqual({ text: "decoded", bytesRead: 7, truncated: true });
  });
});

describe("readResponseTextCapped limits", () => {
  it("reports zero bytes for a bodyless response with a negative limit", async () => {
    await expect(readResponseTextCapped(new Response(null), -1)).resolves.toEqual({
      text: "",
      bytesRead: 0,
      truncated: false,
    });
  });

  it("rejects non-finite byte limits", async () => {
    await expect(readResponseTextCapped(new Response(null), Number.NaN))
      .rejects.toThrow(RangeError);
  });
});
