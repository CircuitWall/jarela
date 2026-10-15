import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { LOCAL_EMBEDDING_CONFIG_NAME, LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL_ID, LOCAL_EMBEDDING_PROVIDER_NAME } from "@/lib/embeddings/constants";

const localEmbedSpy = vi.fn();
vi.mock("@/lib/embeddings/local", () => ({
  embedLocally: (texts: string[]) => localEmbedSpy(texts),
}));
const localModel = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
}));
vi.mock("@/lib/embeddings/local-model", () => ({
  getLocalModelStatus: localModel.status,
  startLocalModelDownload: localModel.start,
}));

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-doc-settings-"));
process.env.JARELA_DB_DIR = tmpRoot;
const { GET, PUT } = await import("./route");
const {
  getEmbeddingModelConfigName,
  setEmbeddingModelConfigName,
  setLocalEmbeddingsEnabled,
  isLocalEmbeddingsEnabled,
} = await import("@/lib/stores/app-settings");

function putRequest(name: string) {
  return new NextRequest("http://localhost/api/v1/documents/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embedding_model_config: name }),
  });
}

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  setEmbeddingModelConfigName(null);
  setLocalEmbeddingsEnabled(false);
  localEmbedSpy.mockReset().mockResolvedValue([new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.01)]);
  localModel.status.mockReset().mockReturnValue({ state: "ready", source: "downloaded", totalBytes: 135_000_000 });
  localModel.start.mockReset().mockResolvedValue("/data/models/local-embedding/");
});

describe("document embedding settings", () => {
  it("persists and probes the bundled local embedding model", async () => {
    const response = await PUT(putRequest(LOCAL_EMBEDDING_CONFIG_NAME));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getEmbeddingModelConfigName()).toBeNull();
    expect(isLocalEmbeddingsEnabled()).toBe(true);
    expect(body.embedding_probe).toEqual({
      ok: true,
      provider: LOCAL_EMBEDDING_PROVIDER_NAME,
      model_id: LOCAL_EMBEDDING_MODEL_ID,
      dimension: LOCAL_EMBEDDING_DIMENSIONS,
    });
    expect(localEmbedSpy).toHaveBeenCalledWith(["Jarela local embedding capability probe"]);
  });

  it("rejects unknown model config names", async () => {
    const response = await PUT(putRequest("missing-config"));
    expect(response.status).toBe(400);
  });

  it("reprobes the selected local model on settings reads", async () => {
    await PUT(putRequest(LOCAL_EMBEDDING_CONFIG_NAME));
    localEmbedSpy.mockClear();

    const response = await GET();
    const body = await response.json();

    expect(body.embedding_model_config).toBe(LOCAL_EMBEDDING_CONFIG_NAME);
    expect(getEmbeddingModelConfigName()).toBeNull();
    expect(isLocalEmbeddingsEnabled()).toBe(true);
    expect(body.embedding_probe).toMatchObject({ ok: true, provider: LOCAL_EMBEDDING_PROVIDER_NAME });
    expect(localEmbedSpy).toHaveBeenCalledTimes(1);
  });

  it("starts the one-time model download when Jarela Local is selected and reports progress", async () => {
    localModel.status
      .mockReturnValueOnce({ state: "missing", totalBytes: 135_000_000 })
      .mockReturnValue({ state: "downloading", totalBytes: 135_000_000 });

    const body = await (await PUT(putRequest(LOCAL_EMBEDDING_CONFIG_NAME))).json();

    expect(localModel.start).toHaveBeenCalledWith({ force: true });
    expect(body.embedding_probe).toEqual({
      ok: false,
      provider: LOCAL_EMBEDDING_PROVIDER_NAME,
      model_id: LOCAL_EMBEDDING_MODEL_ID,
      downloading: true,
      error: "downloading the model (~135 MB, one time)",
    });
    expect(localEmbedSpy).not.toHaveBeenCalled();
  });

  it("surfaces a failed download without forcing a retry on reads", async () => {
    await PUT(putRequest(LOCAL_EMBEDDING_CONFIG_NAME));
    localModel.start.mockClear();
    localModel.status.mockReturnValue({ state: "failed", totalBytes: 1, error: "download failed (503) after 5 attempts" });

    const body = await (await GET()).json();

    expect(localModel.start).toHaveBeenCalledWith({ force: false });
    expect(body.embedding_probe).toMatchObject({ ok: false, error: "download failed (503) after 5 attempts" });
    expect(body.embedding_probe.downloading).toBeUndefined();
  });
});
