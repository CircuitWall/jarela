import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readJsonResponse } from "./http-json";

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
});