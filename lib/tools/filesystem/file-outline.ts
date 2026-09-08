// Lightweight, regex-based structural outline of a text file. Used by
// file_read to attach a navigation map when the agent reads a file
// without a line range (i.e. it is exploring, not zooming in).
//
// Goal is to let the LLM go from "what's in this file?" to a targeted
// follow-up `file_read start_line=… end_line=…` in one extra read,
// instead of grep + guess + re-read + re-read. Costs ~O(lines) of
// regex work and a small JSON payload (~30 entries on a typical 800-
// line file). We do NOT try to be a real parser — we only need useful
// jump targets, not an AST.

import path from "node:path";

export interface OutlineEntry {
  kind: string;
  name: string;
  line: number;
  depth?: number;
}

const TEXT_EXTS = new Set([
  ".md", ".mdx", ".markdown",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".json", ".jsonc",
  ".yml", ".yaml",
  ".toml",
  ".sh", ".bash", ".zsh", ".ps1", ".psm1",
  ".rs", ".go", ".java", ".kt", ".kts", ".swift", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs",
  ".rb", ".php", ".lua", ".sql",
  ".css", ".scss", ".less", ".html", ".xml",
  ".txt", ".log", ".env", ".gitignore", ".dockerignore",
]);

// Extensions we KNOW are binary. Without this, an empty .png passes the
// NUL-byte sniff (no NUL ⇒ "text") and the unknown-extension fallback
// would happily outline a zero-byte image.
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".tif", ".heic", ".heif", ".avif",
  ".mp3", ".mp4", ".m4a", ".wav", ".ogg", ".flac", ".webm", ".mov", ".avi", ".mkv",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".class", ".jar", ".wasm",
  ".db", ".sqlite", ".sqlite3",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
]);

/**
 * Cheap binary sniff. Returns true when the buffer "looks like" text we
 * can safely scan line-by-line. We treat presence of a NUL byte in the
 * first 4 KB as the canonical "binary" signal (same heuristic git uses).
 */
export function looksLikeText(sample: string): boolean {
  // Hot path: substring + indexOf is faster than allocating a regex.
  const probe = sample.length > 4096 ? sample.slice(0, 4096) : sample;
  return probe.indexOf("\u0000") === -1;
}

/**
 * Decide whether a file is worth outlining. We outline by extension
 * when we recognise it; for unknown extensions we still outline if the
 * content looks textual and is small enough that the regex scan is
 * cheap.
 */
export function shouldOutline(absPath: string, content: string): boolean {
  const ext = path.extname(absPath).toLowerCase();
  if (BINARY_EXTS.has(ext)) return false;
  if (TEXT_EXTS.has(ext)) return looksLikeText(content);
  // Unknown extension: only outline if it looks like text AND is
  // bounded — outlining a 5 MB log dump is fine but pointless.
  if (!looksLikeText(content)) return false;
  return content.length <= 256 * 1024;
}

/**
 * Build a structural outline. Dispatches on extension; falls back to a
 * generic heading/section scan for anything unrecognised.
 */
export function buildOutline(absPath: string, content: string): OutlineEntry[] {
  const ext = path.extname(absPath).toLowerCase();
  const lines = content.split(/\r?\n/);
  switch (ext) {
    case ".md":
    case ".mdx":
    case ".markdown":
      return outlineMarkdown(lines);
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return outlineJsLike(lines);
    case ".py":
    case ".pyi":
      return outlinePython(lines);
    case ".json":
    case ".jsonc":
      return outlineJson(lines);
    case ".yml":
    case ".yaml":
      return outlineYaml(lines);
    case ".toml":
      return outlineToml(lines);
    case ".sh":
    case ".bash":
    case ".zsh":
      return outlineShell(lines);
    case ".ps1":
    case ".psm1":
      return outlinePowerShell(lines);
    case ".rs":
      return outlineRust(lines);
    case ".go":
      return outlineGo(lines);
    case ".java":
    case ".kt":
    case ".kts":
    case ".cs":
    case ".swift":
    case ".cpp":
    case ".cc":
    case ".c":
    case ".h":
    case ".hpp":
      return outlineCFamily(lines);
    default:
      return outlineGeneric(lines);
  }
}

// --- markdown -----------------------------------------------------------

function outlineMarkdown(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let inFence = false;
  const fenceRe = /^\s*(```|~~~)/;
  const atxRe = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceRe.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = atxRe.exec(line);
    if (m) {
      out.push({ kind: "heading", name: m[2], line: i + 1, depth: m[1].length });
      continue;
    }
    // Setext: a line followed by ===/--- is an h1/h2.
    if (i + 1 < lines.length && line.trim().length > 0) {
      const next = lines[i + 1].trim();
      if (/^=+$/.test(next)) {
        out.push({ kind: "heading", name: line.trim(), line: i + 1, depth: 1 });
      } else if (/^-+$/.test(next) && next.length >= 3) {
        out.push({ kind: "heading", name: line.trim(), line: i + 1, depth: 2 });
      }
    }
  }
  return out;
}

// --- JS / TS ------------------------------------------------------------

function outlineJsLike(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  // Only top-level declarations: 0 leading whitespace. Nested functions
  // / methods are intentionally skipped — class bodies are reachable
  // from the class entry, and the agent rarely needs to jump straight
  // to a nested helper.
  const patterns: Array<{ re: RegExp; kind: string }> = [
    { re: /^export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { re: /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { re: /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { re: /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { re: /^export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { re: /^interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { re: /^export\s+type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
    { re: /^type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
    { re: /^export\s+enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
    { re: /^enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
    // Arrow-function or value bindings at the top level. Common React /
    // Next.js component pattern: `export const Foo = (...) => ...`.
    { re: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "const" },
    { re: /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "const" },
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip lines that don't start at column 0 — keeps us "top-level only".
    if (line.length === 0 || line[0] === " " || line[0] === "\t") continue;
    for (const { re, kind } of patterns) {
      const m = re.exec(line);
      if (m) {
        out.push({ kind, name: m[1], line: i + 1 });
        break;
      }
    }
  }
  return out;
}

// --- python -------------------------------------------------------------

function outlinePython(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const re = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) {
      const depth = Math.floor(m[1].replace(/\t/g, "    ").length / 4);
      out.push({ kind: m[2] === "def" ? "function" : "class", name: m[3], line: i + 1, depth });
    }
  }
  return out;
}

// --- JSON ---------------------------------------------------------------

function outlineJson(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  // Top-level keys in a JSON object are indented exactly one level. We
  // don't try to parse — depth-1 string-key lines is good enough for
  // package.json / tsconfig.json / similar config files.
  const re = /^\s{2,4}"([^"\\]+)"\s*:/;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (depth === 1) {
      const m = re.exec(line);
      if (m) out.push({ kind: "key", name: m[1], line: i + 1 });
    }
    for (const ch of line) {
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
    }
  }
  return out;
}

// --- YAML ---------------------------------------------------------------

function outlineYaml(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  // Top-level keys: zero indent, ends with ":".
  const topRe = /^([A-Za-z_][\w.-]*)\s*:/;
  // Second-level keys: 2-space indent, ends with ":".
  const subRe = /^(?: {2}|\t)([A-Za-z_][\w.-]*)\s*:/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0 || line[0] === "#") continue;
    let m = topRe.exec(line);
    if (m) {
      out.push({ kind: "key", name: m[1], line: i + 1, depth: 0 });
      continue;
    }
    m = subRe.exec(line);
    if (m) out.push({ kind: "key", name: m[1], line: i + 1, depth: 1 });
  }
  return out;
}

// --- TOML ---------------------------------------------------------------

function outlineToml(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const re = /^\s*\[\[?([^\]]+)\]\]?\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) out.push({ kind: "section", name: m[1], line: i + 1 });
  }
  return out;
}

// --- shell --------------------------------------------------------------

function outlineShell(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const re = /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{?/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0 || line[0] === " " || line[0] === "\t" || line[0] === "#") continue;
    const m = re.exec(line);
    if (m) out.push({ kind: "function", name: m[1], line: i + 1 });
  }
  return out;
}

// --- PowerShell ---------------------------------------------------------

function outlinePowerShell(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const re = /^\s*function\s+([A-Za-z_][\w-]*)/i;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) out.push({ kind: "function", name: m[1], line: i + 1 });
  }
  return out;
}

// --- Rust ---------------------------------------------------------------

function outlineRust(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const re = /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+|unsafe\s+|const\s+|extern(?:\s+"[^"]+")?\s+)*(fn|struct|enum|trait|impl|mod|type)\s+([A-Za-z_][\w]*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) out.push({ kind: m[1], name: m[2], line: i + 1 });
  }
  return out;
}

// --- Go -----------------------------------------------------------------

function outlineGo(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const fn = /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)/;
  const ty = /^type\s+([A-Za-z_][\w]*)\s+(struct|interface|=|[A-Za-z_])/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = fn.exec(line);
    if (m) { out.push({ kind: "function", name: m[1], line: i + 1 }); continue; }
    m = ty.exec(line);
    if (m) out.push({ kind: "type", name: m[1], line: i + 1 });
  }
  return out;
}

// --- C / C++ / Java / Kotlin / C# / Swift -------------------------------

function outlineCFamily(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const cls = /^\s*(?:public|private|protected|internal|abstract|sealed|static|final|open|data)*\s*(class|interface|struct|enum)\s+([A-Za-z_][\w]*)/;
  // Function-ish: `<modifiers> <return-type> name(...)` at column 0 or
  // 4-space class indent. Very loose; matches false positives but
  // never matches non-function noise like comments.
  const fn = /^\s{0,4}(?:public|private|protected|internal|static|final|abstract|virtual|override|async|inline|extern)\s+[A-Za-z_<>:[\],\s.*&]+?\s+([A-Za-z_][\w]*)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = cls.exec(line);
    if (m) { out.push({ kind: m[1], name: m[2], line: i + 1 }); continue; }
    m = fn.exec(line);
    if (m) out.push({ kind: "function", name: m[1], line: i + 1 });
  }
  return out;
}

// --- generic fallback ---------------------------------------------------

function outlineGeneric(lines: string[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  // Recognise markdown-style headings even in unknown files (lots of
  // READMEs / NOTES files don't have a .md extension).
  const atxRe = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = atxRe.exec(lines[i]);
    if (m) out.push({ kind: "heading", name: m[2], line: i + 1, depth: m[1].length });
  }
  return out;
}

// --- truncation ---------------------------------------------------------

const MAX_OUTLINE_ENTRIES = 200;

/**
 * Cap outline size so a 10 000-line file doesn't push a 5 000-entry
 * payload into the LLM's context. Truncation is mentioned in the
 * envelope so the agent knows it can ask for line-ranged slices to see
 * the rest.
 */
export function capOutline(entries: OutlineEntry[]): { entries: OutlineEntry[]; truncated: boolean } {
  if (entries.length <= MAX_OUTLINE_ENTRIES) return { entries, truncated: false };
  return { entries: entries.slice(0, MAX_OUTLINE_ENTRIES), truncated: true };
}
