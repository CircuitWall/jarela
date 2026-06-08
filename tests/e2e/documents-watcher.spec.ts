import { test, expect, request as pwRequest } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// E2E for the watcher → script-firing → indexer pipeline (ADR-0028 PR-D).
// Sequence:
//   1. POST a local_folder source pointing at a fresh tmpdir.
//   2. Write a Markdown file with a unique sentinel string into it.
//   3. Poll the documents search endpoint until the sentinel matches.
//   4. Delete the file and confirm the row is reaped.
//
// The webServer in playwright.config.ts boots with
// JARELA_SCHEDULER_TICK_MS=250, so debounce (500 ms) + tick (250 ms) +
// indexing settle inside the 15 s polling budget below.
//
// Skipped on Linux: fs.watch with `recursive: true` is unsupported
// there (the handler at lib/triggers/handlers/fs-watch.ts logs once
// and falls back to the 10-min full sweep). CI runs on ubuntu-latest
// so this spec never runs on CI.
//
// Skipped on Windows: fs.watch is best-effort on NTFS and drops
// events under concurrent IO load (the parallel Playwright projects +
// the doc-source sweep all hammer the same watcher state). The same
// behaviour is fully covered by the deterministic unit suite at
// lib/triggers/handlers/fs-watch.test.ts which uses the
// __pushEventForTest seam — that's where regression coverage lives.
test.describe.configure({ mode: "serial" });
test.skip(
  process.platform !== "darwin",
  "fs-watch e2e is macOS-only — Linux lacks recursive fs.watch, Windows drops events under load; unit tests cover both",
);

let sourceDir: string;
let sourceId: string | null = null;

test.beforeAll(() => {
  sourceDir = mkdtempSync(join(tmpdir(), "jarela-e2e-watcher-"));
});

test.afterAll(async ({ }, testInfo) => {
  // afterAll doesn't get the request fixture — build a fresh one from
  // the configured baseURL so we can clean up the source row.
  if (sourceId) {
    try {
      const ctx = await pwRequest.newContext({
        baseURL: testInfo.project.use.baseURL,
      });
      await ctx.delete(`/api/v1/documents/sources/${sourceId}`);
      await ctx.dispose();
    } catch { /* noop */ }
  }
  try { rmSync(sourceDir, { recursive: true, force: true }); } catch { /* noop */ }
});

async function waitForHit(
  request: import("@playwright/test").APIRequestContext,
  query: string,
  sid: string,
  timeoutMs = 15_000,
): Promise<{ rel_path: string; text: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request.get(
      `/api/v1/documents/search?q=${encodeURIComponent(query)}&source_id=${sid}&limit=5`,
    );
    if (res.ok()) {
      const body = (await res.json()) as { hits: Array<{ rel_path: string; text: string }> };
      if (body.hits.length > 0) return body.hits[0];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function waitForNoHit(
  request: import("@playwright/test").APIRequestContext,
  query: string,
  sid: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request.get(
      `/api/v1/documents/search?q=${encodeURIComponent(query)}&source_id=${sid}&limit=5`,
    );
    if (res.ok()) {
      const body = (await res.json()) as { hits: unknown[] };
      if (body.hits.length === 0) return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

test("watcher picks up a new file and indexes it without a manual reindex", async ({ request }) => {
  const res = await request.post("/api/v1/documents/sources", {
    data: { path: sourceDir, label: "e2e watcher" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { id: string };
  sourceId = body.id;

  const sentinel = `watchertestmarker${Date.now()}`;
  const fileAbs = join(sourceDir, "watcher-fixture.md");
  writeFileSync(fileAbs, `# Watcher fixture\n\nUnique marker: ${sentinel}\n`);

  const hit = await waitForHit(request, sentinel, sourceId);
  expect(hit, `expected to find a hit for ${sentinel} via watcher`).not.toBeNull();
  expect(hit!.rel_path).toContain("watcher-fixture.md");
  expect(hit!.text).toContain(sentinel);
});

test("watcher reaps a deleted file from the index", async ({ request }) => {
  expect(sourceId, "previous test must have created the source").not.toBeNull();
  const sentinel = `watcherdeletemarker${Date.now()}`;
  const fileAbs = join(sourceDir, "delete-me.md");
  writeFileSync(fileAbs, `# Delete fixture\n\nUnique marker: ${sentinel}\n`);

  const hit = await waitForHit(request, sentinel, sourceId!);
  expect(hit, "file should appear before we delete it").not.toBeNull();

  unlinkSync(fileAbs);

  const gone = await waitForNoHit(request, sentinel, sourceId!);
  expect(gone, "watcher should evict the row after the file is removed").toBe(true);
});
