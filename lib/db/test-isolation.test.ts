import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, relative, isAbsolute } from "node:path";
import { getDataDir } from "./data-dir";

// This file deliberately does not set JARELA_DB_DIR: it proves the shared
// Vitest setup isolates every test file from the user's real data directory.
describe("test data directory isolation", () => {
  it("resolves to a per-file temp directory, never the real data directory", () => {
    const dir = realpathSync(getDataDir());
    const rel = relative(realpathSync(tmpdir()), dir);
    expect(rel === "" || rel.startsWith("..") || isAbsolute(rel)).toBe(false);
    expect(basename(dir)).toMatch(/^jarela-test-data-/);
  });
});
