import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import path from "node:path";
import { GET } from "@/app/api/v1/local-file/route";

describe("local-file route", () => {
  it("previews localhost file links as workspace-relative paths", async () => {
    const href = encodeURIComponent("http://localhost:4312/README.md");
    const res = await GET(new NextRequest(`http://localhost/api/v1/local-file?href=${href}`));
    const body = await res.json() as { path: string; renderable: boolean; snippet: string };

    expect(res.status).toBe(200);
    expect(body.renderable).toBe(true);
    expect(path.normalize(body.path)).toBe(path.join(process.cwd(), "README.md"));
    expect(body.snippet).toContain("Jarela");
  });
});