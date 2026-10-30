import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getDataDir } from "@/lib/db/data-dir";
import { SkillExecutionArtifact } from "@/lib/skills/execution-artifact";
import { readSkillFileBytes } from "@/lib/skills/bundle-files";

function directoryIdentity(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    throw new Error("Skill run directory must have an unlinked canonical identity");
  }
  return { dev: stat.dev, ino: stat.ino };
}

export class SkillRunStaging {
  readonly directory: string;
  readonly #identity: ReturnType<typeof directoryIdentity>;
  readonly #artifact: SkillExecutionArtifact;
  #disposed = false;

  private constructor(directory: string, artifact: SkillExecutionArtifact) {
    this.directory = directory;
    this.#identity = directoryIdentity(directory);
    this.#artifact = artifact;
  }

  static create(artifact: SkillExecutionArtifact): SkillRunStaging {
    const root = join(resolve(getDataDir()), "skill-runs");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    directoryIdentity(root);
    const directory = mkdtempSync(join(root, "run-"));
    const staging = new SkillRunStaging(directory, artifact);
    try {
      for (const file of artifact.files) {
        const target = join(directory, ...file.path.split("/"));
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, artifact.readFile(file.path), { flag: "wx", mode: 0o400 });
      }
      staging.verify();
      return staging;
    } catch (error) {
      try { staging.dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Skill staging failed and cleanup failed"); }
      throw error;
    }
  }

  verify(): void {
    this.#assertIdentity();
    const files = new Set(this.#artifact.files.map((file) => file.path));
    const directories = new Set<string>();
    for (const file of files) {
      const parts = file.split("/");
      for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"));
    }
    const pending = [""];
    while (pending.length) {
      const relative = pending.pop()!;
      for (const entry of readdirSync(join(this.directory, ...relative.split("/").filter(Boolean)), { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || !files.has(path) && !directories.has(path)) throw new Error("Unexpected staged skill entry");
        if (entry.isDirectory() && directories.has(path)) pending.push(path);
        else if (!entry.isFile() || !files.has(path)) throw new Error("Invalid staged skill entry");
      }
    }
    for (const file of this.#artifact.files) {
      const bytes = readSkillFileBytes(this.directory, file.path, file.bytes);
      if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new Error("Staged skill bytes changed");
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#assertIdentity();
    rmSync(this.directory, { recursive: true, force: false });
    this.#disposed = true;
  }

  #assertIdentity(): void {
    if (this.#disposed) throw new Error("Skill staging is disposed");
    const current = directoryIdentity(this.directory);
    if (current.dev !== this.#identity.dev || current.ino !== this.#identity.ino) {
      throw new Error("Skill staging identity changed");
    }
  }
}
