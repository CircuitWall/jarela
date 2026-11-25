import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-credentials-route-"));
process.env.JARELA_DB_DIR = tmpRoot;

vi.mock("@/lib/health/credential-probe", () => ({
  probeCredentialAfterSave: vi.fn(async () => null),
}));

const { createCredential, deleteCredential, listCredentials, getCredential, getCredentialParams } =
  await import("@/lib/stores/credentials");
const { GET, POST } = await import("./route");
const { PUT, DELETE } = await import("./[id]/route");

const request = (method: string, path: string, body?: unknown) => new NextRequest(
  `http://localhost${path}`,
  { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } },
);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

afterEach(() => {
  for (const row of listCredentials()) deleteCredential(row.id);
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("credential API redaction", () => {
  it("masks secret params on list, create, and update responses", async () => {
    const created = await POST(request("POST", "/api/v1/credentials?force=1", {
      type: "model", provider: "synthetic", params: { api_key: "sk-secret", base_url: "https://example" },
    }));
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.params).toMatchObject({ api_key: "***", base_url: "https://example" });

    const list = await GET(request("GET", "/api/v1/credentials"));
    const rows = await list.json() as Array<{ id: string; params: Record<string, unknown> }>;
    expect(rows.find((row) => row.id === createdBody.id)?.params.api_key).toBe("***");

    const updated = await PUT(request("PUT", `/api/v1/credentials/${createdBody.id}?force=1`, {
      params: { api_key: "***", base_url: "https://changed" },
    }), ctx(createdBody.id));
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.params).toMatchObject({ api_key: "***", base_url: "https://changed" });

    const stored = getCredential(createdBody.id)!;
    expect(getCredentialParams(stored)).toMatchObject({ api_key: "sk-secret", base_url: "https://changed" });
  });

  it("refuses to delete a credential still referenced by a model config", async () => {
    const { upsertModelConfig, deleteModelConfig } = await import("@/lib/stores/model-config");
    createCredential({
      id: "referenced", type: "model", provider: "synthetic", params: { api_key: "sk-secret" },
    });
    upsertModelConfig("bound", "synthetic", "model", {}, false, "referenced");
    const response = await DELETE(request("DELETE", "/api/v1/credentials/referenced"), ctx("referenced"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "in_use" });
    deleteModelConfig("bound");
  });
});
