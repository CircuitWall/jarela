import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { currentWorkspace } from "@/lib/tools/workspace-context";
import { errorMessage } from "@/lib/utils/error";

const MAX_SNIPPET_BYTES = 16_384;
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".csv", ".diff", ".env", ".go", ".h", ".hpp", ".html", ".ini", ".java",
  ".js", ".json", ".jsx", ".log", ".md", ".markdown", ".mjs", ".mts", ".patch", ".ps1", ".py", ".rb", ".rs", ".sh", ".sql",
  ".text", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function stripLineFragment(raw: string): string {
  const hashIdx = raw.indexOf("#");
  return hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
}

function normalizeHrefToPath(rawHref: string): string | null {
  let href = stripLineFragment(rawHref).trim();
  if (!href) return null;
  let fromLocalhostUrl = false;

  try {
    if (/^file:\/\//i.test(href)) return fileURLToPath(href);
  } catch {
    return null;
  }

  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (!isLocalhost(url.hostname)) return null;
      href = decodeURIComponent(url.pathname);
      fromLocalhostUrl = true;
    } catch {
      return null;
    }
  }

  href = href.replace(/\//g, path.sep);
  if (process.platform === "win32" && /^\\[A-Za-z]:[\\/]/.test(href)) href = href.slice(1);
  else if (fromLocalhostUrl && href.startsWith(path.sep)) href = href.slice(1);
  if (href === "~" || href.startsWith(`~${path.sep}`)) return path.join(os.homedir(), href.slice(2));
  return href;
}

function resolveLocalPath(rawHref: string, threadId?: string | null): string | null {
  const localPath = normalizeHrefToPath(rawHref);
  if (!localPath) return null;
  if (path.isAbsolute(localPath)) return path.resolve(localPath);

  const workspace = currentWorkspace(threadId ? { configurable: { thread_id: threadId } } : undefined);
  return path.resolve(workspace?.root ?? process.cwd(), localPath);
}

function isTextLike(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
  }
  return suspicious > buffer.length * 0.08;
}

export async function GET(req: NextRequest) {
  const href = req.nextUrl.searchParams.get("href");
  const threadId = req.nextUrl.searchParams.get("thread_id");
  if (!href) return NextResponse.json({ error: "href is required" }, { status: 400 });

  const abs = resolveLocalPath(href, threadId);
  if (!abs) return NextResponse.json({ error: "not a local file path" }, { status: 400 });

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return NextResponse.json({ error: "file does not exist or is unreadable", path: abs }, { status: 404 });
  }
  if (!stat.isFile()) return NextResponse.json({ error: "path is not a file", path: abs }, { status: 400 });

  const name = path.basename(abs);
  const shouldRead = isTextLike(name) || stat.size <= MAX_SNIPPET_BYTES;
  if (!shouldRead) {
    return NextResponse.json({ path: abs, name, size: stat.size, renderable: false, truncated: false });
  }

  const buffer = await fs.readFile(abs).then((b) => b.subarray(0, MAX_SNIPPET_BYTES));
  if (looksBinary(buffer)) {
    return NextResponse.json({ path: abs, name, size: stat.size, renderable: false, truncated: false });
  }

  return NextResponse.json({
    path: abs,
    name,
    size: stat.size,
    renderable: true,
    snippet: buffer.toString("utf8"),
    truncated: stat.size > buffer.length,
  });
}

export async function POST(req: NextRequest) {
  let body: { href?: unknown; thread_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.href !== "string") return NextResponse.json({ error: "href is required" }, { status: 400 });
  const threadId = typeof body.thread_id === "string" ? body.thread_id : null;
  const abs = resolveLocalPath(body.href, threadId);
  if (!abs) return NextResponse.json({ error: "not a local file path" }, { status: 400 });

  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return NextResponse.json({ error: "path is not a file", path: abs }, { status: 400 });
    openWithDefaultProgram(abs);
    return NextResponse.json({ ok: true, path: abs });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e), path: abs }, { status: 400 });
  }
}

function openWithDefaultProgram(abs: string): void {
  const child = process.platform === "win32"
    ? spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Process -LiteralPath $args[0]", abs], { detached: true, stdio: "ignore", windowsHide: true })
    : process.platform === "darwin"
      ? spawn("open", [abs], { detached: true, stdio: "ignore" })
      : spawn("xdg-open", [abs], { detached: true, stdio: "ignore" });
  child.unref();
}