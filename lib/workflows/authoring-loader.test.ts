import { afterAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldExtension } from "./authoring";

const root = mkdtempSync(join(tmpdir(), "jarela-authoring-loader-"));
const toolsDir = join(root, "autoload");
vi.stubEnv("JARELA_DB_DIR", join(root, "data"));
vi.stubEnv("JARELA_TOOLS_DIR", toolsDir);
const { resetConfigCache } = await import("@/lib/env/config");
resetConfigCache();
const { loadExternalTools, _resetExternalCache } = await import("@/lib/tools/runtime/external");
const { setToolConfig } = await import("@/lib/stores/tool-config");
const { closeDb } = await import("@/lib/db");
afterAll(() => {
  closeDb();
  vi.unstubAllEnvs();
  resetConfigCache();
  rmSync(root, { recursive: true, force: true });
});

function scan() {
  _resetExternalCache();
  return loadExternalTools(new Set());
}

describe("generated scaffold interoperability with the existing external loader", () => {
  it("keeps staged bytes inert, loads only an explicit test-owned copy and verifies failed update/removal/restoration", async () => {
    const scaffold = scaffoldExtension({
      name: "fixture_echo", goal: "Read a synthetic echo",
      discovery: { decision: "author", evidence: "Synthetic fixture needs an echo tool" },
    });
    if (!scaffold.ok) throw new Error("Expected scaffold");
    const staging = join(root, "staging");
    mkdirSync(staging);
    mkdirSync(toolsDir);
    for (const file of scaffold.files) writeFileSync(join(staging, file.path), file.content);
    expect(scan().tools).toHaveLength(0);

    const source = scaffold.files.find((file) => file.path === "fixture_echo.cjs");
    if (!source) throw new Error("Missing tool source");
    const installed = join(toolsDir, source.path);
    // Test-owned copying is not an implementation of product install approval.
    writeFileSync(installed, source.content);
    const loaded = scan();
    expect(loaded.errors).toEqual([]);
    expect(loaded.tools.map((tool) => tool.name)).toEqual(["fixture_echo"]);
    expect(loaded.configs.get("fixture_echo")).toEqual([expect.objectContaining({ key: "base_url", required: true })]);
    await expect(loaded.tools[0].invoke({ value: "synthetic" })).rejects.toThrow("Configure the local fixture URL");

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ value: url.searchParams.get("value") }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected loopback fixture port");
      setToolConfig("fixture_echo", "base_url", `http://127.0.0.1:${address.port}`);
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(JSON.parse(String(await loaded.tools[0].invoke({ value: "synthetic" })))).toEqual({ value: "synthetic" });
      }

      writeFileSync(installed, source.content.replace("async run(args, ctx) {", 'async run(args, ctx) { throw new Error("Synthetic failed update");'));
      await expect(scan().tools[0].invoke({ value: "synthetic" })).rejects.toThrow("Synthetic failed update");
      unlinkSync(installed);
      expect(scan().tools).toHaveLength(0);
      writeFileSync(installed, source.content);
      expect(JSON.parse(String(await scan().tools[0].invoke({ value: "restored" })))).toEqual({ value: "restored" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
