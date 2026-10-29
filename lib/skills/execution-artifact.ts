import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { portableSkillPath, readSkillFileBytes, SkillFileSizeError } from "./bundle-files";
import { parseSkillExecutionManifest, SKILL_INSPECTION_LIMITS, type SkillExecutionManifest } from "./execution-manifest";

export interface SkillArtifactFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

function decodeManifest(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, "");
}

function rootIdentity(root: string) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Skill directory must not be a symbolic link");
  return { device: stat.dev, inode: stat.ino, realpath: realpathSync(root) };
}

function frame(hash: ReturnType<typeof createHash>, value: Buffer) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(value.length));
  hash.update(size).update(value);
}

// In-memory content identity only: no staged executable, filesystem lock or consent.
export class SkillExecutionArtifact {
  readonly revision: string;
  readonly totalBytes: number;
  readonly files: readonly SkillArtifactFile[];
  readonly #contents: Map<string, Buffer>;

  private constructor(contents: Map<string, Buffer>) {
    this.#contents = contents;
    const hash = createHash("sha256").update("jarela-skill-artifact-v1\0");
    const files: SkillArtifactFile[] = [];
    let total = 0;
    for (const [path, bytes] of contents) {
      frame(hash, Buffer.from(path, "utf8"));
      frame(hash, bytes);
      files.push(Object.freeze({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
      total += bytes.length;
    }
    this.revision = hash.digest("hex");
    this.totalBytes = total;
    this.files = Object.freeze(files);
    Object.freeze(this);
  }

  getManifest(): SkillExecutionManifest {
    return parseSkillExecutionManifest(decodeManifest(this.#contents.get("execution.json")!));
  }

  readFile(path: string): Buffer {
    portableSkillPath.parse(path);
    const bytes = this.#contents.get(path);
    if (!bytes) throw new Error("File is not part of the captured skill artifact");
    return Buffer.from(bytes);
  }

  static capture(directory: string): SkillExecutionArtifact {
    const root = resolve(directory);
    const identity = rootIdentity(root);
    const manifestBytes = readSkillFileBytes(root, "execution.json", SKILL_INSPECTION_LIMITS.manifestBytes);
    const manifest = parseSkillExecutionManifest(decodeManifest(manifestBytes));
    const paths = new Set(["execution.json", "SKILL.md"]);
    for (const path of manifest.files) {
      const reserved = ["execution.json", "SKILL.md"].find((name) => name.toLowerCase() === path.toLowerCase());
      if (reserved && reserved !== path) throw new Error("Declared metadata paths must use their exact reserved spelling");
      paths.add(path);
    }
    const contents = new Map<string, Buffer>();
    let total = 0;
    for (const path of [...paths].sort()) {
      const bytes = path === "execution.json" ? manifestBytes : readSkillFileBytes(root, path, SKILL_INSPECTION_LIMITS.fileBytes);
      total += bytes.length;
      if (total > SKILL_INSPECTION_LIMITS.totalBytes) throw new SkillFileSizeError("Captured artifact exceeds 4 MiB including metadata");
      contents.set(path, bytes);
    }
    // Detect ordinary source changes across capture; this is not an atomic filesystem snapshot.
    for (const [path, bytes] of contents) {
      const limit = path === "execution.json" ? SKILL_INSPECTION_LIMITS.manifestBytes : SKILL_INSPECTION_LIMITS.fileBytes;
      if (!bytes.equals(readSkillFileBytes(root, path, limit))) throw new Error("Skill source changed during artifact capture");
    }
    const final = rootIdentity(root);
    if (identity.device !== final.device || identity.inode !== final.inode || identity.realpath !== final.realpath) {
      throw new Error("Skill directory changed during artifact capture");
    }
    return new SkillExecutionArtifact(contents);
  }
}
