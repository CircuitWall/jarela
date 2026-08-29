import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/attachments/spill", () => ({
  spillImageBuffer: vi.fn(async (_buf: Buffer, media_type: string) => ({
    type: "image_ref",
    media_type,
    name: "heic.jpg",
    sha256: "sha",
    size: 3,
  })),
  spillImagePart: vi.fn(),
}));

const { POST } = await import("@/app/api/v1/attachments/images/route");
const { spillImageBuffer } = await import("@/lib/attachments/spill");

describe("POST /api/v1/attachments/images", () => {
  it("accepts HEIC uploads even when the browser omits File.type", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "IMG_7209(1).HEIC", { type: "" }));

    const res = await POST(new Request("http://local/api/v1/attachments/images", {
      method: "POST",
      body: form,
    }) as never);

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ type: "image_ref", media_type: "image/heic" });
    expect(spillImageBuffer).toHaveBeenCalledWith(expect.any(Buffer), "image/heic");
  });

  it("rejects multipart uploads without a file", async () => {
    const form = new FormData();
    form.append("not_file", "x");

    const res = await POST(new Request("http://local/api/v1/attachments/images", {
      method: "POST",
      body: form,
    }) as never);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "file is required" });
  });

  it("rejects unknown multipart file types", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "notes.bin", { type: "" }));

    const res = await POST(new Request("http://local/api/v1/attachments/images", {
      method: "POST",
      body: form,
    }) as never);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "file must be an image" });
  });

  it("accepts legacy JSON image uploads", async () => {
    const { spillImagePart } = await import("@/lib/attachments/spill");
    vi.mocked(spillImagePart).mockResolvedValueOnce({
      type: "image_ref",
      media_type: "image/png",
      name: "png.png",
      sha256: "png",
      size: 4,
    });

    const res = await POST(new Request("http://local/api/v1/attachments/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_type: "image/png", data: "abcd" }),
    }) as never);

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ type: "image_ref", media_type: "image/png" });
    expect(spillImagePart).toHaveBeenCalledWith({ type: "image", media_type: "image/png", data: "abcd" });
  });

  it("returns validation errors for invalid JSON upload bodies", async () => {
    const res = await POST(new Request("http://local/api/v1/attachments/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_type: "application/octet-stream", data: "abcd" }),
    }) as never);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "media_type must be an image MIME type" });
  });
});
