import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/attachments/spill", () => ({
  spillFileBuffer: vi.fn(async (_buf: Buffer, media_type: string, filename: string) => ({
    type: "file_ref",
    media_type,
    name: "file.pdf",
    filename,
    sha256: "sha",
    size: 3,
  })),
}));

const { POST } = await import("@/app/api/v1/attachments/files/route");
const { spillFileBuffer } = await import("@/lib/attachments/spill");

describe("POST /api/v1/attachments/files", () => {
  it("accepts multipart binary files", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "report.pdf", { type: "application/pdf" }));

    const res = await POST(new Request("http://local/api/v1/attachments/files", {
      method: "POST",
      body: form,
    }) as never);

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ type: "file_ref", filename: "report.pdf" });
    expect(spillFileBuffer).toHaveBeenCalledWith(expect.any(Buffer), "application/pdf", "report.pdf");
  });

  it("rejects non-multipart requests", async () => {
    const res = await POST(new Request("http://local/api/v1/attachments/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }) as never);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Request body must be multipart/form-data" });
  });

  it("rejects multipart requests without a file", async () => {
    const form = new FormData();
    form.append("not_file", "x");

    const res = await POST(new Request("http://local/api/v1/attachments/files", {
      method: "POST",
      body: form,
    }) as never);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "file is required" });
  });

  it("falls back to octet-stream when the browser omits File.type", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "archive.bin", { type: "" }));

    const res = await POST(new Request("http://local/api/v1/attachments/files", {
      method: "POST",
      body: form,
    }) as never);

    expect(res.status).toBe(201);
    expect(spillFileBuffer).toHaveBeenCalledWith(expect.any(Buffer), "application/octet-stream", "archive.bin");
  });
});