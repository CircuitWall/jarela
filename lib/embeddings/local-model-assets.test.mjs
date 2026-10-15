import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_MODEL_FILES,
  LOCAL_MODEL_REPOSITORY,
  LOCAL_MODEL_REVISION,
  ensureLocalModelAssets,
  localModelDir,
  verifyLocalModelAssets,
} from "./local-model-assets.mjs";

const payloads = { "config.json": Buffer.from("{}"), "onnx/model.onnx": Buffer.from("weights") };
const files = Object.entries(payloads).map(([path, bytes]) => ({
  path,
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
}));

let dir;
let assetsRoot;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarela-model-"));
  assetsRoot = join(dir, "models", "local-embedding");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fetchFrom(map) {
  return vi.fn(async (url) => {
    const path = decodeURIComponent(new URL(url).pathname.split(`/resolve/${LOCAL_MODEL_REVISION}/`)[1]);
    return map[path];
  });
}

describe("local model assets", () => {
  it("pins every file by size and a content hash", () => {
    expect(LOCAL_MODEL_REPOSITORY).toBe("Xenova/multilingual-e5-small");
    for (const file of LOCAL_MODEL_FILES) {
      expect(file.size).toBeGreaterThan(0);
      expect(Boolean(file.sha256 || file.gitBlobOid)).toBe(true);
    }
  });

  it("downloads from the pinned revision, verifies, and installs atomically", async () => {
    const fetchBytes = fetchFrom(payloads);

    await expect(ensureLocalModelAssets(assetsRoot, { files, fetchBytes })).resolves.toBe("downloaded");

    expect(fetchBytes.mock.calls.map(([url]) => url)).toEqual(files.map((file) =>
      `https://huggingface.co/${LOCAL_MODEL_REPOSITORY}/resolve/${LOCAL_MODEL_REVISION}/${file.path}?download=true`));
    expect(await verifyLocalModelAssets(assetsRoot, { files })).toEqual([]);
    expect(readFileSync(join(localModelDir(assetsRoot), "MODEL-NOTICE.txt"), "utf8")).toContain(LOCAL_MODEL_REVISION);
    expect(readdirSync(join(dir, "models"))).toEqual(["local-embedding"]);
  });

  it("skips the network when the installed model already verifies", async () => {
    await ensureLocalModelAssets(assetsRoot, { files, fetchBytes: fetchFrom(payloads) });
    const fetchBytes = fetchFrom(payloads);

    await expect(ensureLocalModelAssets(assetsRoot, { files, fetchBytes })).resolves.toBe("verified");
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it("rejects tampered downloads and keeps the previous install untouched", async () => {
    await ensureLocalModelAssets(assetsRoot, { files, fetchBytes: fetchFrom(payloads) });
    writeFileSync(join(localModelDir(assetsRoot), "config.json"), "[]");

    await expect(ensureLocalModelAssets(assetsRoot, {
      files,
      fetchBytes: fetchFrom({ ...payloads, "onnx/model.onnx": Buffer.from("WEIGHTS") }),
    })).rejects.toThrow("SHA-256 mismatch for onnx/model.onnx");

    expect(readFileSync(join(localModelDir(assetsRoot), "config.json"), "utf8")).toBe("[]");
    expect(readdirSync(join(dir, "models"))).toEqual(["local-embedding"]);
  });

  it("reports missing and corrupt files", async () => {
    mkdirSync(join(localModelDir(assetsRoot), "onnx"), { recursive: true });
    writeFileSync(join(localModelDir(assetsRoot), "onnx", "model.onnx"), "weightz");

    expect(await verifyLocalModelAssets(assetsRoot, { files })).toEqual([
      "missing config.json",
      "SHA-256 mismatch for onnx/model.onnx",
    ]);
  });
});
