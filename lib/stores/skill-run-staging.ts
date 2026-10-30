import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { getDataDir } from "@/lib/db/data-dir";
import { SkillExecutionArtifact } from "@/lib/skills/execution-artifact";
import { readSkillFileBytes } from "@/lib/skills/bundle-files";

function directoryIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    throw new Error("Skill run directory must have an unlinked canonical identity");
  }
  return { dev: stat.dev, ino: stat.ino };
}

const ownershipSchema = z.strictObject({
  schemaVersion: z.literal(1), pid: z.number().int().positive(),
  device: z.string(), inode: z.string(),
  state: z.enum(["prepared", "launched", "cleanup_verified"]),
});

export class SkillRunStaging {
  readonly directory: string;
  readonly #identity: ReturnType<typeof directoryIdentity>;
  readonly #artifact: SkillExecutionArtifact;
  #disposed = false;
  readonly #ownerFile: string;

  private constructor(directory: string, artifact: SkillExecutionArtifact) {
    this.directory = directory;
    this.#identity = directoryIdentity(directory);
    this.#artifact = artifact;
    const owners = join(resolve(getDataDir()), "skill-run-owners");
    mkdirSync(owners, { recursive: true, mode: 0o700 });
    directoryIdentity(owners);
    this.#ownerFile = join(owners, `${basename(directory)}.json`);
    writeFileSync(this.#ownerFile, this.#ownership("prepared"), { flag: "wx", mode: 0o600 });
  }

  static create(artifact: SkillExecutionArtifact): SkillRunStaging {
    const root = join(resolve(getDataDir()), "skill-runs");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    directoryIdentity(root);
    const directory = mkdtempSync(join(root, "run-"));
    const createdIdentity = directoryIdentity(directory);
    let staging: SkillRunStaging | undefined;
    try {
      staging = new SkillRunStaging(directory, artifact);
      for (const file of artifact.files) {
        const target = join(directory, ...file.path.split("/"));
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, artifact.readFile(file.path), { flag: "wx", mode: 0o400 });
      }
      staging.verify();
      return staging;
    } catch (error) {
      try {
        if (staging) staging.dispose();
        else {
          const current = directoryIdentity(directory);
          if (current.dev !== createdIdentity.dev || current.ino !== createdIdentity.ino) throw new Error("Unowned staging identity changed");
          rmSync(directory, { recursive: true, force: false });
        }
      }
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
    rmSync(this.#ownerFile, { force: false });
    this.#disposed = true;
  }

  markLaunched(): void {
    this.#assertIdentity();
    this.#updateOwnership("launched");
  }

  markCleanupVerified(): void {
    this.#assertIdentity();
    this.#updateOwnership("cleanup_verified");
  }

  #updateOwnership(state: z.infer<typeof ownershipSchema>["state"]) {
    directoryIdentity(dirname(this.#ownerFile));
    const temporary = `${this.#ownerFile}.${randomUUID()}`;
    writeFileSync(temporary, this.#ownership(state), { flag: "wx", mode: 0o600 });
    try { renameSync(temporary, this.#ownerFile); }
    catch (error) {
      rmSync(temporary, { force: false });
      throw error;
    }
  }

  #ownership(state: z.infer<typeof ownershipSchema>["state"]) {
    return JSON.stringify({ schemaVersion: 1, pid: process.pid,
      device: String(this.#identity.dev), inode: String(this.#identity.ino), state });
  }

  #assertIdentity(): void {
    if (this.#disposed) throw new Error("Skill staging is disposed");
    const current = directoryIdentity(this.directory);
    if (current.dev !== this.#identity.dev || current.ino !== this.#identity.ino) {
      throw new Error("Skill staging identity changed");
    }
  }

}

export function cleanupAbandonedSkillStaging() {
    const root = join(resolve(getDataDir()), "skill-runs");
    const owners = join(resolve(getDataDir()), "skill-run-owners");
    const result: { removed: string[]; retained: Array<{ directory: string; reason: string }> } = { removed: [], retained: [] };
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(owners, { recursive: true, mode: 0o700 });
    directoryIdentity(root); directoryIdentity(owners);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const directory = join(root, entry.name);
      try {
        if (!/^run-[A-Za-z0-9]+$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error("Unrecognized staging entry");
        }
        const current = directoryIdentity(directory);
        const ownerName = `${entry.name}.json`;
        const metadata = ownershipSchema.parse(JSON.parse(readSkillFileBytes(owners, ownerName, 4096).toString("utf8")));
        if (metadata.device !== String(current.dev) || metadata.inode !== String(current.ino)) throw new Error("Staging identity changed");
        try { process.kill(metadata.pid, 0); throw new Error("Staging owner may still be alive"); }
        catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
        }
        if (metadata.state === "launched") throw new Error("Process cleanup was never verified; retain for explicit review");
        const checked = directoryIdentity(directory);
        if (checked.dev !== current.dev || checked.ino !== current.ino) throw new Error("Staging identity changed");
        rmSync(directory, { recursive: true, force: false });
        rmSync(join(owners, ownerName), { force: false });
        result.removed.push(entry.name);
      } catch (error) {
        result.retained.push({ directory: entry.name, reason: error instanceof Error ? error.message : "Cleanup verification failed" });
      }
    }
    return result;
}
