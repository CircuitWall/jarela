// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { submitRun } from "./client";
import type { ContentPart } from "./types";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("submitRun", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits small attachment payloads inline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const attachments: ContentPart[] = [
      { type: "image", media_type: "image/png", data: "tiny" },
    ];

    await expect(submitRun("thread-1", "look", new AbortController().signal, undefined, attachments))
      .resolves.toEqual({ accepted: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/threads/thread-1/run");
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { attachments: ContentPart[] };
    expect(body.attachments).toEqual(attachments);
  });

  it("uploads inline images before submitting oversized run payloads", async () => {
    const refA: ContentPart = { type: "image_ref", media_type: "image/png", name: "a.png", sha256: "a" };
    const refB: ContentPart = { type: "image_ref", media_type: "image/jpeg", name: "b.jpg", sha256: "b" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(refA, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse(refB, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const attachments: ContentPart[] = [
      { type: "image", media_type: "image/png", data: "a".repeat(4_600_000) },
      { type: "image", media_type: "image/jpeg", data: "b".repeat(4_600_000) },
    ];

    await expect(submitRun("thread-1", "compare", new AbortController().signal, undefined, attachments))
      .resolves.toEqual({ accepted: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/attachments/images");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/attachments/images");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/threads/thread-1/run");

    const runBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string) as { attachments: ContentPart[] };
    expect(runBody.attachments).toEqual([refA, refB]);
    expect((fetchMock.mock.calls[2]?.[1]?.body as string).length).toBeLessThan(1_000);
  });
});