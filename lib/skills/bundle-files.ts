import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export class SkillFileSizeError extends Error {}

export const portableSkillPath = z.string().min(1).max(240).refine((value) => value.split("/").every((segment) =>
  segment !== "." && segment !== ".." && segment.length > 0
  && !/[<>:"\\|?*\x00-\x1f\x7f]/.test(segment)
  && !/[. ]$/.test(segment)
  && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\.|$)/i.test(segment),
), "Use a portable relative file path with no traversal, device names or backslashes");

export function regularSkillFile(root: string, relative: string) {
  portableSkillPath.parse(relative);
  const directory = lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Skill directory must not be a symbolic link");
  const segments = relative.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error("Expected regular files and directories, without symbolic links");
    }
    if (index === segments.length - 1) return stat;
  }
  throw new Error("Missing file path");
}

export function readSkillTextFile(root: string, relative: string, maxBytes: number): { content: string; bytes: number } {
  const before = regularSkillFile(root, relative);
  if (before.size > maxBytes) throw new SkillFileSizeError(`File exceeds ${maxBytes} bytes`);
  const fd = openSync(join(root, ...relative.split("/")), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("File changed during read");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (read === 0) break;
      bytes += read;
    }
    if (bytes > maxBytes) throw new SkillFileSizeError(`File exceeds ${maxBytes} bytes`);
    const after = regularSkillFile(root, relative);
    const final = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || final.size !== opened.size
      || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) {
      throw new Error("File changed during read");
    }
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes));
    if (content.includes("\0")) throw new Error("Binary resources are unsupported; request a UTF-8 text file");
    return { content, bytes };
  } finally {
    closeSync(fd);
  }
}
