import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-doc-tools-"));
process.env.JARELA_DB_DIR = join(tmpRoot, "db");

const { documentsAddLocalSource, documentsListSources } = await import("./documents");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("documents_add_local_source", () => {
  let sourceDir: string;

  beforeAll(() => {
    sourceDir = join(tmpRoot, "workspace-docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "README.md"), "hello");
  });

  it("adds a valid local directory source", async () => {
    const out = JSON.parse(await documentsAddLocalSource.invoke({
      path: sourceDir,
      label: "Docs",
    })) as { ok?: boolean; id?: string; kind?: string; path?: string };

    expect(out.ok).toBe(true);
    expect(out.id).toBeTruthy();
    expect(out.kind).toBe("local_folder");
    expect(out.path).toBe(sourceDir);

    const listed = JSON.parse(await documentsListSources.invoke({})) as {
      sources: Array<{ id: string; path: string; label: string | null }>;
    };
    expect(listed.sources.some((s) => s.path === sourceDir && s.label === "Docs")).toBe(true);
  });

  it("rejects duplicate paths", async () => {
    const out = JSON.parse(await documentsAddLocalSource.invoke({
      path: sourceDir,
      label: "Docs again",
    })) as { error?: string };

    expect(out.error).toContain("already exists");
  });

  it("rejects non-directory paths", async () => {
    const filePath = join(tmpRoot, "not-a-dir.txt");
    writeFileSync(filePath, "x");

    const out = JSON.parse(await documentsAddLocalSource.invoke({
      path: filePath,
      label: "bad",
    })) as { error?: string };

    expect(out.error).toBe("path is not a directory");
  });
});
