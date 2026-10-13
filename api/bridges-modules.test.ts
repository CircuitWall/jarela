import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-bridge-modules-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { GET: listBridges, POST: createBridge } = await import("@/app/api/v1/bridges/route");
const { GET: listBridgeKinds } = await import("@/app/api/v1/bridges/kinds/route");
const { POST: lookupBridge } = await import("@/app/api/v1/bridges/[id]/lookup/route");

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/bridges", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("bridge module API", () => {
  it("lists serializable module metadata", async () => {
    const response = await listBridgeKinds();
    const body = await response.json();
    expect(body).toMatchObject([{
      kind: "whatsapp",
      label: "WhatsApp",
      chatDirectory: true,
      pairing: { actionLabel: "Re-pair" },
    }]);
    expect(body[0]).not.toHaveProperty("createAdapter");
    expect(body[0]).not.toHaveProperty("removeAuth");
  });

  it("creates a bridge for a registered module kind", async () => {
    const response = await createBridge(request({ kind: "whatsapp", name: "test bridge" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ kind: "whatsapp", name: "test bridge" });
    expect(await (await listBridges()).json()).toHaveLength(1);
  });

  it("rejects bridge kinds that are not registered", async () => {
    const response = await createBridge(request({ kind: "unknown-channel", name: "test bridge" }));
    expect(response.status).toBe(400);
  });

  it("accepts generic lookup input and legacy phone payloads", async () => {
    const createResponse = await createBridge(request({ kind: "whatsapp", name: "lookup bridge" }));
    const bridge = await createResponse.json() as { id: string };
    const postLookup = (body: unknown) => lookupBridge(
      new NextRequest(`http://localhost/api/v1/bridges/${bridge.id}/lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: bridge.id }) },
    );

    expect((await postLookup({ input: "contact-id" })).status).toBe(200);
    expect((await postLookup({ phone: "+1 555 0100" })).status).toBe(200);
  });
});
