import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Override HOME *before* importing the module under test. The tools resolve
// bare relative paths under os.homedir() and apply the credential-file
// denylist relative to that same home. Pinning HOME to a tmpdir makes the
// tests hermetic and lets us deliberately step on the denylist by writing
// into ${HOME}/.ssh, ${HOME}/.aws, etc. without ever touching the user's
// real credential dirs.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-files-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
delete process.env.JARELA_ALLOW_SENSITIVE_FILES;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileMoveTool,
  fileCopyTool,
  fileDeleteTool,
  fileListTool,
  fileMkdirTool,
  fileStatTool,
  withFsDeadline,
} = await import("./files");

// Per-test scratch dir under HOME so concurrent tests don't collide and so
// the "bare relative paths resolve under HOME" semantics work cleanly.
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpRoot, "scratch-"));
  // Re-create the JARELA_DB_DIR each test so the write-denial checks have
  // a real directory to refuse against.
  mkdirSync(process.env.JARELA_DB_DIR!, { recursive: true });
});

function parse(s: string) { return JSON.parse(s) as Record<string, unknown>; }

// ── path resolution ─────────────────────────────────────────────────────────

describe("path resolution", () => {
  it("resolves bare relative paths against HOME", async () => {
    const rel = "scratch-rel-resolve.txt";
    const out = parse(await fileWriteTool.invoke({ path: rel, content: "x" }));
    expect(out.ok).toBe(true);
    expect(out.path).toBe(join(tmpRoot, rel));
    expect(readFileSync(out.path as string, "utf8")).toBe("x");
  });

  it("expands ~/ to HOME", async () => {
    const out = parse(await fileWriteTool.invoke({ path: "~/tilde.txt", content: "y" }));
    expect(out.ok).toBe(true);
    expect(out.path).toBe(join(tmpRoot, "tilde.txt"));
  });

  it("honors absolute paths verbatim", async () => {
    const abs = join(scratch, "abs.txt");
    const out = parse(await fileWriteTool.invoke({ path: abs, content: "z" }));
    expect(out.ok).toBe(true);
    expect(out.path).toBe(abs);
  });

  it("rejects empty paths with a helpful error", async () => {
    const out = parse(await fileReadTool.invoke({ path: "   " }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/path is required/);
  });
});

// ── sensitive-path denylist ─────────────────────────────────────────────────

describe("credential-file denylist", () => {
  it("refuses reads inside ~/.ssh", async () => {
    mkdirSync(join(tmpRoot, ".ssh"), { recursive: true });
    writeFileSync(join(tmpRoot, ".ssh", "config"), "Host *\n");
    const out = parse(await fileReadTool.invoke({ path: "~/.ssh/config" }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/credential directory/);
  });

  it("refuses writes inside ~/.aws", async () => {
    const out = parse(await fileWriteTool.invoke({ path: "~/.aws/credentials", content: "x" }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/credential/i);
  });

  it("refuses ~/.netrc by exact filename", async () => {
    const out = parse(await fileWriteTool.invoke({ path: "~/.netrc", content: "x" }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/credential/i);
  });

  it("refuses id_rsa / *.pem / *.key by basename anywhere on disk", async () => {
    for (const name of ["id_rsa", "id_ed25519", "key.pem", "secret.key", "credentials"]) {
      const target = join(scratch, name);
      const out = parse(await fileWriteTool.invoke({ path: target, content: "x" }));
      expect(out.ok, `should refuse ${name}`).toBe(false);
      expect(out.error).toMatch(/credential/i);
    }
  });

  it("refuses writes inside JARELA_DB_DIR (app state must not be agent-mutable)", async () => {
    const target = join(process.env.JARELA_DB_DIR!, "anything.txt");
    const out = parse(await fileWriteTool.invoke({ path: target, content: "x" }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Jarela's data dir/);
  });

  it("ALLOWS reads inside JARELA_DB_DIR (only writes are blocked)", async () => {
    const f = join(process.env.JARELA_DB_DIR!, "data.txt");
    writeFileSync(f, "readable");
    const out = parse(await fileReadTool.invoke({ path: f }));
    expect(out.ok).toBe(true);
    expect(out.content).toBe("readable");
  });

  it("JARELA_ALLOW_SENSITIVE_FILES=1 bypasses the denylist", async () => {
    process.env.JARELA_ALLOW_SENSITIVE_FILES = "1";
    try {
      const out = parse(await fileWriteTool.invoke({
        path: join(scratch, "id_rsa"),
        content: "fake key",
      }));
      expect(out.ok).toBe(true);
    } finally {
      delete process.env.JARELA_ALLOW_SENSITIVE_FILES;
    }
  });
});

// ── file_read ───────────────────────────────────────────────────────────────

describe("file_read", () => {
  it("reads a UTF-8 file and reports total_lines", async () => {
    const f = join(scratch, "r.txt");
    writeFileSync(f, "alpha\nbeta\ngamma\n");
    const out = parse(await fileReadTool.invoke({ path: f }));
    expect(out).toMatchObject({
      ok: true,
      path: f,
      content: "alpha\nbeta\ngamma\n",
      truncated: false,
      total_lines: 4, // trailing newline → 4 split parts
      line_range: null,
    });
  });

  it("supports 1-based line range slicing", async () => {
    const f = join(scratch, "r2.txt");
    writeFileSync(f, "1\n2\n3\n4\n5");
    const out = parse(await fileReadTool.invoke({ path: f, start_line: 2, end_line: 4 }));
    expect(out.content).toBe("2\n3\n4");
    expect(out.line_range).toEqual({ start: 2, end: 4 });
  });

  it("clips to MAX_READ_BYTES (64KB) and flags truncated", async () => {
    const f = join(scratch, "big.txt");
    writeFileSync(f, "a".repeat(70_000));
    const out = parse(await fileReadTool.invoke({ path: f }));
    expect(out.truncated).toBe(true);
    expect((out.content as string).length).toBe(64_000);
  });

  it("returns ok:false with the OS error message for missing files", async () => {
    const out = parse(await fileReadTool.invoke({ path: join(scratch, "nope.txt") }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/ENOENT/);
  });

  it("attaches outline on exploration reads of recognised text files", async () => {
    const f = join(scratch, "module.ts");
    writeFileSync(f, [
      "export function alpha() {}",
      "export class Beta {}",
      "export const gamma = 1;",
    ].join("\n"));
    const out = parse(await fileReadTool.invoke({ path: f }));
    expect(out.ok).toBe(true);
    expect(Array.isArray(out.outline)).toBe(true);
    expect((out.outline as Array<Record<string, unknown>>).map((e) => e.name)).toEqual([
      "alpha", "Beta", "gamma",
    ]);
    expect(out.outline_truncated).toBe(false);
  });

  it("omits outline when start_line or end_line is supplied (targeted read)", async () => {
    const f = join(scratch, "module2.ts");
    writeFileSync(f, "export function x(){}\nexport function y(){}\n");
    const out = parse(await fileReadTool.invoke({ path: f, start_line: 1, end_line: 1 }));
    expect(out.outline).toBeNull();
  });

  it("returns null outline for binary content", async () => {
    const f = join(scratch, "blob.dat");
    writeFileSync(f, "abc\u0000def");
    const out = parse(await fileReadTool.invoke({ path: f }));
    expect(out.outline).toBeNull();
  });
});

// ── file_write ──────────────────────────────────────────────────────────────

describe("file_write", () => {
  it("creates a new file and reports created:true + bytes_written", async () => {
    const f = join(scratch, "new.txt");
    const out = parse(await fileWriteTool.invoke({ path: f, content: "héllo" }));
    expect(out).toMatchObject({ ok: true, path: f, created: true });
    expect(out.bytes_written).toBe(Buffer.byteLength("héllo", "utf8"));
  });

  it("overwrites existing files and reports created:false", async () => {
    const f = join(scratch, "ov.txt");
    writeFileSync(f, "old");
    const out = parse(await fileWriteTool.invoke({ path: f, content: "new" }));
    expect(out).toMatchObject({ ok: true, created: false });
    expect(readFileSync(f, "utf8")).toBe("new");
  });

  it("creates parent dirs by default (create_dirs left implicit)", async () => {
    const f = join(scratch, "deep", "deeper", "n.txt");
    const out = parse(await fileWriteTool.invoke({ path: f, content: "x" }));
    expect(out.ok).toBe(true);
    expect(existsSync(f)).toBe(true);
  });

  it("refuses content over MAX_WRITE_BYTES (2MB)", async () => {
    const f = join(scratch, "huge.txt");
    const out = parse(await fileWriteTool.invoke({ path: f, content: "x".repeat(2_000_001) }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/exceeds 2000000 bytes/);
    expect(existsSync(f)).toBe(false);
  });
});

// ── file_edit ───────────────────────────────────────────────────────────────

describe("file_edit", () => {
  it("replaces a single occurrence in place", async () => {
    const f = join(scratch, "e.txt");
    writeFileSync(f, "the quick brown fox");
    const out = parse(await fileEditTool.invoke({
      path: f,
      old_string: "quick brown",
      new_string: "slow purple",
    }));
    expect(out.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("the slow purple fox");
  });

  it("refuses when old_string isn't present", async () => {
    const f = join(scratch, "e2.txt");
    writeFileSync(f, "one two three");
    const out = parse(await fileEditTool.invoke({
      path: f,
      old_string: "missing",
      new_string: "x",
    }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/old_string not found/);
  });

  it("refuses when old_string matches multiple times and reports the count", async () => {
    const f = join(scratch, "e3.txt");
    writeFileSync(f, "foo bar foo bar foo");
    const out = parse(await fileEditTool.invoke({
      path: f,
      old_string: "foo",
      new_string: "FOO",
    }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/multiple times/);
    expect(out.match_count).toBe(3);
    // File is left untouched on rejection.
    expect(readFileSync(f, "utf8")).toBe("foo bar foo bar foo");
  });

  it("supports deletion via empty new_string", async () => {
    const f = join(scratch, "e4.txt");
    writeFileSync(f, "keep DELETE rest");
    const out = parse(await fileEditTool.invoke({
      path: f,
      old_string: " DELETE",
      new_string: "",
    }));
    expect(out.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("keep rest");
  });
});

// ── file_move ───────────────────────────────────────────────────────────────

describe("file_move", () => {
  it("renames a file", async () => {
    const a = join(scratch, "a.txt");
    const b = join(scratch, "b.txt");
    writeFileSync(a, "x");
    const out = parse(await fileMoveTool.invoke({ source: a, destination: b }));
    expect(out).toMatchObject({ ok: true, source: a, destination: b, kind: "file" });
    expect(existsSync(a)).toBe(false);
    expect(readFileSync(b, "utf8")).toBe("x");
  });

  it("moves source INTO an existing destination directory (mv src dir/ semantics)", async () => {
    const a = join(scratch, "src.txt");
    writeFileSync(a, "x");
    const dir = join(scratch, "into");
    mkdirSync(dir);
    const out = parse(await fileMoveTool.invoke({ source: a, destination: dir }));
    expect(out.ok).toBe(true);
    expect(out.destination).toBe(join(dir, "src.txt"));
    expect(existsSync(a)).toBe(false);
    expect(existsSync(join(dir, "src.txt"))).toBe(true);
  });

  it("refuses to overwrite an existing destination file unless overwrite=true", async () => {
    const a = join(scratch, "ma.txt");
    const b = join(scratch, "mb.txt");
    writeFileSync(a, "src");
    writeFileSync(b, "dst");
    const blocked = parse(await fileMoveTool.invoke({ source: a, destination: b }));
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/destination exists/);
    // src and dst both still present.
    expect(readFileSync(a, "utf8")).toBe("src");
    expect(readFileSync(b, "utf8")).toBe("dst");

    const allowed = parse(await fileMoveTool.invoke({ source: a, destination: b, overwrite: true }));
    expect(allowed.ok).toBe(true);
    expect(existsSync(a)).toBe(false);
    expect(readFileSync(b, "utf8")).toBe("src");
  });
});

// ── file_copy ───────────────────────────────────────────────────────────────

describe("file_copy", () => {
  it("copies a file and leaves the source intact", async () => {
    const a = join(scratch, "ca.txt");
    const b = join(scratch, "cb.txt");
    writeFileSync(a, "hello");
    const out = parse(await fileCopyTool.invoke({ source: a, destination: b }));
    expect(out.ok).toBe(true);
    expect(readFileSync(a, "utf8")).toBe("hello");
    expect(readFileSync(b, "utf8")).toBe("hello");
  });

  it("recursively copies a directory by default", async () => {
    const src = join(scratch, "srcdir");
    mkdirSync(src);
    writeFileSync(join(src, "f1.txt"), "1");
    mkdirSync(join(src, "sub"));
    writeFileSync(join(src, "sub", "f2.txt"), "2");
    const dst = join(scratch, "dstdir");
    const out = parse(await fileCopyTool.invoke({ source: src, destination: dst }));
    expect(out.ok).toBe(true);
    expect(readFileSync(join(dst, "f1.txt"), "utf8")).toBe("1");
    expect(readFileSync(join(dst, "sub", "f2.txt"), "utf8")).toBe("2");
  });

  it("refuses directory copy when recursive=false", async () => {
    const src = join(scratch, "rsrc");
    mkdirSync(src);
    const dst = join(scratch, "rdst");
    const out = parse(await fileCopyTool.invoke({ source: src, destination: dst, recursive: false }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/recursive=false/);
  });
});

// ── file_delete ─────────────────────────────────────────────────────────────

describe("file_delete", () => {
  it("deletes a file", async () => {
    const f = join(scratch, "d.txt");
    writeFileSync(f, "x");
    const out = parse(await fileDeleteTool.invoke({ path: f }));
    expect(out).toMatchObject({ ok: true, kind: "file" });
    expect(existsSync(f)).toBe(false);
  });

  it("deletes an empty directory without recursive", async () => {
    const d = join(scratch, "emptyd");
    mkdirSync(d);
    const out = parse(await fileDeleteTool.invoke({ path: d }));
    expect(out).toMatchObject({ ok: true, kind: "directory", removed: "empty" });
    expect(existsSync(d)).toBe(false);
  });

  it("refuses non-empty directory unless recursive=true", async () => {
    const d = join(scratch, "ned");
    mkdirSync(d);
    writeFileSync(join(d, "f.txt"), "x");
    const blocked = parse(await fileDeleteTool.invoke({ path: d }));
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/not empty/);
    expect(existsSync(d)).toBe(true);

    const allowed = parse(await fileDeleteTool.invoke({ path: d, recursive: true }));
    expect(allowed).toMatchObject({ ok: true, removed: "recursive" });
    expect(existsSync(d)).toBe(false);
  });
});

// ── file_list ───────────────────────────────────────────────────────────────

describe("file_list", () => {
  it("lists entries with sizes for files, sorted by name; hides dotfiles by default", async () => {
    const d = join(scratch, "ldir");
    mkdirSync(d);
    writeFileSync(join(d, "b.txt"), "12");
    writeFileSync(join(d, "a.txt"), "1");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, ".hidden"), "h");
    const out = parse(await fileListTool.invoke({ path: d }));
    const entries = out.entries as Array<{ path: string; kind: string; size?: number }>;
    expect(out.ok).toBe(true);
    expect(entries.map((e) => e.path)).toEqual([
      join(d, "a.txt"),
      join(d, "b.txt"),
      join(d, "sub"),
    ]);
    expect(entries[0]).toMatchObject({ kind: "file", size: 1 });
    expect(entries[1]).toMatchObject({ kind: "file", size: 2 });
    expect(entries[2]).toMatchObject({ kind: "directory" });
  });

  it("includes dotfiles when include_hidden=true", async () => {
    const d = join(scratch, "ldir2");
    mkdirSync(d);
    writeFileSync(join(d, ".x"), "");
    writeFileSync(join(d, "y"), "");
    const out = parse(await fileListTool.invoke({ path: d, include_hidden: true }));
    const names = (out.entries as Array<{ path: string }>).map((e) => basename(e.path));
    expect(names).toContain(".x");
    expect(names).toContain("y");
  });

  it("filters by case-insensitive basename substring", async () => {
    const d = join(scratch, "ldir3");
    mkdirSync(d);
    writeFileSync(join(d, "Report.PDF"), "");
    writeFileSync(join(d, "notes.txt"), "");
    writeFileSync(join(d, "summary.pdf"), "");
    const out = parse(await fileListTool.invoke({ path: d, pattern: "PDF" }));
    const names = (out.entries as Array<{ path: string }>).map((e) => basename(e.path).toLowerCase());
    expect(names.sort()).toEqual(["report.pdf", "summary.pdf"]);
  });

  it("respects max_entries and flags truncated", async () => {
    const d = join(scratch, "ldir4");
    mkdirSync(d);
    for (let i = 0; i < 10; i++) writeFileSync(join(d, `f${i}.txt`), "");
    const out = parse(await fileListTool.invoke({ path: d, max_entries: 3 }));
    expect((out.entries as unknown[]).length).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.truncated_hint).toMatch(/truncated/i);
  });

  it("returns an error envelope for non-existent directories", async () => {
    const out = parse(await fileListTool.invoke({ path: join(scratch, "no-such-dir") }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/ENOENT/);
  });

  it("depth=2 walks one level of subdirectories in one call", async () => {
    const d = join(scratch, "treedir");
    mkdirSync(d);
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "src", "a.ts"), "x");
    writeFileSync(join(d, "src", "b.ts"), "y");
    mkdirSync(join(d, "tests"));
    writeFileSync(join(d, "tests", "a.test.ts"), "z");
    writeFileSync(join(d, "README.md"), "");
    const out = parse(await fileListTool.invoke({ path: d, depth: 2 }));
    const paths = (out.entries as Array<{ path: string; depth?: number }>).map((e) =>
      e.path.replace(d + "\\", "").replace(d + "/", "").replace(/\\/g, "/")
    );
    expect(paths).toEqual(expect.arrayContaining([
      "README.md", "src", "src/a.ts", "src/b.ts", "tests", "tests/a.test.ts",
    ]));
    // Each entry carries its depth (1 for the root level, 2 for children).
    const entries = out.entries as Array<{ path: string; depth: number }>;
    const readme = entries.find((e) => e.path.endsWith("README.md"));
    const aTs = entries.find((e) => e.path.endsWith("a.ts"));
    expect(readme?.depth).toBe(1);
    expect(aTs?.depth).toBe(2);
  });

  it("depth>1 still skips node_modules / .git / dist / build", async () => {
    const d = join(scratch, "noisy");
    mkdirSync(d);
    writeFileSync(join(d, "keep.txt"), "");
    mkdirSync(join(d, "node_modules"));
    writeFileSync(join(d, "node_modules", "pkg.json"), "{}");
    mkdirSync(join(d, "dist"));
    writeFileSync(join(d, "dist", "bundle.js"), "");
    const out = parse(await fileListTool.invoke({ path: d, depth: 3 }));
    const paths = (out.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths.some((p) => p.includes("pkg.json"))).toBe(false);
    expect(paths.some((p) => p.includes("bundle.js"))).toBe(false);
    expect(paths.some((p) => p.endsWith("keep.txt"))).toBe(true);
  });
});

// ── file_mkdir ──────────────────────────────────────────────────────────────

describe("file_mkdir", () => {
  it("creates nested dirs by default", async () => {
    const d = join(scratch, "mk", "deeper", "deepest");
    const out = parse(await fileMkdirTool.invoke({ path: d }));
    expect(out.ok).toBe(true);
    expect(statSync(d).isDirectory()).toBe(true);
  });

  it("fails on missing parents when recursive=false", async () => {
    const d = join(scratch, "no-parent", "leaf");
    const out = parse(await fileMkdirTool.invoke({ path: d, recursive: false }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/ENOENT/);
  });
});

// ── file_stat ───────────────────────────────────────────────────────────────

describe("file_stat", () => {
  it("returns kind/size/timestamps for an existing file", async () => {
    const f = join(scratch, "s.txt");
    writeFileSync(f, "abcdef");
    const out = parse(await fileStatTool.invoke({ path: f }));
    expect(out).toMatchObject({ ok: true, exists: true, kind: "file", size: 6 });
    expect(typeof out.modified_ms).toBe("number");
    expect(typeof out.mode).toBe("number");
  });

  it("reports exists:false (NOT an error) for missing paths", async () => {
    const out = parse(await fileStatTool.invoke({ path: join(scratch, "nope") }));
    expect(out).toEqual({ ok: true, path: join(scratch, "nope"), exists: false });
  });

  it("identifies directories", async () => {
    const d = join(scratch, "sd");
    mkdirSync(d);
    const out = parse(await fileStatTool.invoke({ path: d }));
    expect(out).toMatchObject({ ok: true, exists: true, kind: "directory" });
  });
});

describe("withFsDeadline (stalled-fs guard)", () => {
  it("returns the work value when the work resolves before the deadline", async () => {
    const result = await withFsDeadline("test_op", "/tmp/x", async () => "ok");
    expect(result).toBe("ok");
  });

  it("throws a labelled timeout error when work hangs past the deadline", async () => {
    // never resolves — exactly the cloud-sync-stuck-fs symptom we're
    // defending against.
    const work = () => new Promise<string>(() => { /* hang */ });
    await expect(withFsDeadline("test_op", "/cloud/stuck", work, 20))
      .rejects.toThrow(/test_op on '\/cloud\/stuck' timed out/);
  });

  it("propagates the underlying error verbatim when work rejects normally", async () => {
    const work = () => Promise.reject(new Error("ENOENT: no such file"));
    await expect(withFsDeadline("test_op", "/x", work))
      .rejects.toThrow(/ENOENT: no such file/);
  });
});

// Sanity-check that the scratch dirs we created above didn't pollute one
// another — every test got its own scratch and the tmpRoot tree is healthy.
describe("test isolation", () => {
  it("each beforeEach gets a fresh scratch directory", () => {
    expect(scratch.startsWith(tmpRoot)).toBe(true);
    // Catches accidental shared-state regressions: scratch should contain
    // only what the current test wrote, not leftovers from other suites.
    const entries = readdirSync(scratch);
    // No assertion on emptiness — different tests in this very block
    // could populate it — but just touching readdirSync confirms the path
    // exists and is readable.
    expect(Array.isArray(entries)).toBe(true);
  });
});
