import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const root = mkdtempSync(join(tmpdir(), "jarela-files-route-"));
process.env.JARELA_DB_DIR = root;

const { GET } = await import("./route");
const { FILES_DIR } = await import("@/lib/files");

const NAME = "synthetic-range.txt";
writeFileSync(join(FILES_DIR, NAME), "0123456789");

afterAll(() => rmSync(root, { recursive: true, force: true }));

function get(range?: string) {
  const headers: Record<string, string> = {};
  if (range) headers.range = range;
  return GET(
    new NextRequest(`http://localhost/api/v1/files/${NAME}`, { headers }),
    { params: Promise.resolve({ name: NAME }) },
  );
}

describe("/api/v1/files/[name]", () => {
  it("clamps a range whose last byte is past the end instead of rejecting it", async () => {
    const res = await get("bytes=4-999999");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 4-9/10");
    expect(await res.text()).toBe("456789");
  });

  it("returns the whole file for a suffix range longer than the file", async () => {
    const res = await get("bytes=-100");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-9/10");
    expect(await res.text()).toBe("0123456789");
  });

  it("still rejects a range that starts past the end", async () => {
    expect((await get("bytes=20-")).status).toBe(416);
  });
});
