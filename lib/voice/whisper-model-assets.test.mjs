import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  WHISPER_MODEL_FILES,
  WHISPER_MODEL_REPOSITORY,
  WHISPER_MODEL_REVISION,
  WHISPER_MODEL_TOTAL_BYTES,
  verifyWhisperModelAssets,
} from "./whisper-model-assets.mjs";

const dir = mkdtempSync(join(tmpdir(), "jarela-whisper-assets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("whisper model assets", () => {
  it("pins the model to an immutable revision", () => {
    expect(WHISPER_MODEL_REPOSITORY).toBe("Xenova/whisper-tiny");
    expect(WHISPER_MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
  });

  it("pins every file by size and a content hash", () => {
    for (const file of WHISPER_MODEL_FILES) {
      expect(file.size).toBeGreaterThan(0);
      expect(Boolean(file.sha256 || file.gitBlobOid)).toBe(true);
    }
    expect(WHISPER_MODEL_TOTAL_BYTES).toBeLessThan(50_000_000);
  });

  it("reports every missing file instead of accepting a partial install", async () => {
    const problems = await verifyWhisperModelAssets(dir);
    expect(problems).toHaveLength(WHISPER_MODEL_FILES.length);
    expect(problems.every((problem) => problem.startsWith("missing "))).toBe(true);
  });
});
