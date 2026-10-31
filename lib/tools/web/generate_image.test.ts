import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiKey: "test-key" as string | null,
  writes: [] as Array<{ name: string; bytes: number }>,
}));

vi.mock("@/lib/utils/google-api", () => ({
  resolveGoogleApiKey: () => mocks.apiKey,
  timeoutSignal: () => undefined,
}));
vi.mock("@/lib/files", () => ({
  writeBinaryFile: (name: string, data: Buffer) => { mocks.writes.push({ name, bytes: data.length }); },
}));
vi.mock("@/lib/env/config", () => ({ getConfig: () => ({ imageTimeoutMs: 1_000 }) }));

const { generateImageTool } = await import("./generate_image");

const PNG = Buffer.from("fake-png").toString("base64");
const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function generate(args: Record<string, unknown>) {
  return JSON.parse(String(await generateImageTool.invoke(args as never)));
}

describe("generate_image as used by an agent", () => {
  beforeEach(() => {
    mocks.apiKey = "test-key";
    mocks.writes = [];
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves a Gemini image and returns embeddable markdown", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }] }));
    const result = await generate({ prompt: "a red bicycle" });
    expect(result.images).toHaveLength(1);
    expect(result.markdown).toMatch(/^!\[a red bicycle\]\(\/api\/v1\/files\/img-.+\.png\)$/);
    expect(mocks.writes).toHaveLength(1);
  });

  it("rejects a blank prompt before calling the provider", async () => {
    await expect(generate({ prompt: "   " })).rejects.toThrow(/prompt is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains missing credentials without calling the provider", async () => {
    mocks.apiKey = null;
    await expect(generate({ prompt: "cat" })).rejects.toThrow(/Google API key not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the upstream status when the error body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(generate({ prompt: "cat" })).rejects.toThrow(/Gemini 502/);
    expect(mocks.writes).toHaveLength(0);
  });

  it("reports an invalid success body instead of a raw parser error", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));
    await expect(generate({ prompt: "cat" })).rejects.toThrow(/Gemini returned an invalid response/);
    expect(mocks.writes).toHaveLength(0);
  });

  it("surfaces a text-only refusal without saving anything", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: "I can't make that." }] } }] }));
    await expect(generate({ prompt: "cat" })).rejects.toThrow(/Gemini returned no image: I can't make that\./);
    expect(mocks.writes).toHaveLength(0);
  });

  it("does not leak the API key in network failure errors", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const error = await generate({ prompt: "cat" }).catch((e: Error) => e);
    expect(String(error)).toMatch(/Gemini request failed: fetch failed/);
    expect(String(error)).not.toContain("test-key");
  });

  it("preserves the cause detail for image-generation connection failures", async () => {
    const cause = Object.assign(new Error("Synthetic connection reset"), { code: "ECONNRESET" });
    fetchMock.mockRejectedValue(new Error("fetch failed", { cause }));
    await expect(generate({ prompt: "Synthetic caption" })).rejects.toThrow(
      "Gemini request failed: fetch failed: Synthetic connection reset (ECONNRESET)",
    );
    expect(mocks.writes).toHaveLength(0);
  });

  it("keeps the upstream status for Imagen non-JSON errors", async () => {
    fetchMock.mockResolvedValue(new Response("upstream timeout", { status: 504 }));
    await expect(generate({ prompt: "cat", model: "imagen-3.0-generate-002" })).rejects.toThrow(/Imagen 504/);
  });

  it("redacts the API key if an error page echoes the request URL", async () => {
    fetchMock.mockResolvedValue(new Response("blocked: /models/x:generateContent?key=test-key", { status: 403 }));
    const error = await generate({ prompt: "cat" }).catch((e: Error) => e);
    expect(String(error)).toMatch(/Gemini 403: .*\[redacted\]/);
    expect(String(error)).not.toContain("test-key");
  });

  it("saves every Imagen prediction for a multi-image request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ predictions: [{ bytesBase64Encoded: PNG }, { bytesBase64Encoded: PNG, mimeType: "image/jpeg" }] }));
    const result = await generate({ prompt: "cat", model: "imagen-3.0-generate-002", count: 2, aspect_ratio: "16:9" });
    expect(result.images.map((i: { mime: string }) => i.mime)).toEqual(["image/png", "image/jpeg"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).parameters).toEqual({ sampleCount: 2, aspectRatio: "16:9" });
  });

  it("rejects an out-of-range count at the schema boundary", async () => {
    await expect(generate({ prompt: "cat", count: 9 })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
