import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-tools-route-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { GET } = await import("@/app/api/v1/tools/route");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("GET /api/v1/tools", () => {
  it("includes usefulness stats for each tool", async () => {
    const res = await GET();
    expect(res.ok).toBe(true);
    const tools = await res.json() as Array<{
      name: string;
      stats?: {
        score: number;
        success_rate: number;
        usefulness_rate: number;
        never_used: boolean;
      };
    }>;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]?.stats).toBeTruthy();
    expect(tools[0]?.stats?.score).toBeGreaterThanOrEqual(0);
    expect(tools[0]?.stats?.score).toBeLessThanOrEqual(1);
    expect(tools[0]?.stats?.success_rate).toBeGreaterThanOrEqual(0);
    expect(tools[0]?.stats?.usefulness_rate).toBeGreaterThanOrEqual(0);
  });
});