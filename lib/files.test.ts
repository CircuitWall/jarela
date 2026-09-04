import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "jarela-files-"));
  vi.resetModules();
  vi.doMock("@/lib/db/data-dir", () => ({ getDataDir: () => tempDir }));
});

afterEach(() => {
  vi.doUnmock("@/lib/db/data-dir");
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

async function loadFiles() {
  return import("./files");
}

describe("file artifact lifecycle", () => {
  it("lists browser text artifacts and generated media", async () => {
    const files = await loadFiles();
    files.writeTextFile("browser-extract-a.txt", "hello");
    files.writeBinaryFile("img-generated.png", Buffer.from([1, 2, 3]));

    const inventory = files.listArtifactFiles();
    expect(inventory.total_files).toBe(2);
    expect(inventory.browser_bytes).toBe(5);
    expect(inventory.generated_bytes).toBe(3);
    expect(inventory.files.map((file) => file.kind).sort()).toEqual(["browser", "generated"]);
  });

  it("dry-runs then deletes lifecycle-managed old artifacts", async () => {
    const files = await loadFiles();
    files.writeTextFile("browser-extract-old.txt", "old");
    files.writeTextFile("browser-extract-new.txt", "new");
    files.writeBinaryFile("attachment-user.png", Buffer.from([1]));

    const now = Date.UTC(2026, 8, 4);
    const oldTime = new Date(now - 10 * 86_400_000);
    const newTime = new Date(now - 1 * 86_400_000);
    utimesSync(join(files.FILES_DIR, "browser-extract-old.txt"), oldTime, oldTime);
    utimesSync(join(files.FILES_DIR, "browser-extract-new.txt"), newTime, newTime);
    utimesSync(join(files.FILES_DIR, "attachment-user.png"), oldTime, oldTime);

    const policy = {
      retention_days: 5,
      max_total_mb: 512,
      include_browser_artifacts: true,
      include_generated_media: true,
    };

    const preview = files.cleanupArtifactFiles(policy, true, now);
    expect(preview.dry_run).toBe(true);
    expect(preview.deleted.map((file) => file.name)).toEqual(["browser-extract-old.txt"]);
    expect(files.listArtifactFiles(now).files.map((file) => file.name).sort()).toEqual([
      "attachment-user.png",
      "browser-extract-new.txt",
      "browser-extract-old.txt",
    ]);

    const cleanup = files.cleanupArtifactFiles(policy, false, now);
    expect(cleanup.deleted_count).toBe(1);
    expect(files.listArtifactFiles(now).files.map((file) => file.name).sort()).toEqual([
      "attachment-user.png",
      "browser-extract-new.txt",
    ]);
  });

  it("uses the storage cap to delete oldest eligible files first", async () => {
    const files = await loadFiles();
    files.writeTextFile("browser-extract-a.txt", "a".repeat(700_000));
    files.writeTextFile("browser-extract-b.txt", "b".repeat(700_000));
    const now = Date.UTC(2026, 8, 4);
    const older = new Date(now - 2 * 86_400_000);
    const newer = new Date(now - 1 * 86_400_000);
    utimesSync(join(files.FILES_DIR, "browser-extract-a.txt"), older, older);
    utimesSync(join(files.FILES_DIR, "browser-extract-b.txt"), newer, newer);

    const cleanup = files.cleanupArtifactFiles({
      retention_days: 365,
      max_total_mb: 1,
      include_browser_artifacts: true,
      include_generated_media: true,
    }, false, now);

    expect(cleanup.deleted.map((file) => file.name)).toEqual(["browser-extract-a.txt"]);
    expect(files.listArtifactFiles(now).files.map((file) => file.name)).toEqual(["browser-extract-b.txt"]);
  });
});
