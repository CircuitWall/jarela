// Filesystem browse endpoint for the folder-picker UI (Documents panel).
//
// Lists immediate subdirectories at a given absolute path so the front-end
// can render a navigable tree. Returns directories only — picking a file
// is meaningless for the indexer.
//
// Trust model: Jarela is single-user / local, the API surface is reachable
// only on the loopback or the user's tailnet. We don't sandbox the path —
// the user could already run `file_list` against anything they have read
// access to. The endpoint refuses to leak file *contents*, only directory
// names, so it's strictly less powerful than the existing file_list tool.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { errorMessage } from "@/lib/utils/error";

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("path");
  const target = raw && raw.trim().length > 0
    ? path.resolve(raw)
    : os.homedir();

  try {
    const st = await fs.stat(target);
    if (!st.isDirectory()) {
      return NextResponse.json({ error: "not a directory" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "path does not exist or is unreadable" }, { status: 400 });
  }

  let entries: { name: string; path: string }[] = [];
  try {
    const dirents = await fs.readdir(target, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    return NextResponse.json(
      { error: errorMessage(e) },
      { status: 400 },
    );
  }

  const parent = path.dirname(target);
  return NextResponse.json({
    path: target,
    parent: parent === target ? null : parent, // null at filesystem root
    home: os.homedir(),
    entries,
  });
}
