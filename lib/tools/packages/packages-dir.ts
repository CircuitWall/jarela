/**
 * Managed packages directory — a leaf module so both the optional-package
 * loader and the on-demand runtime resolver can find it without importing the
 * manifest loader (which imports the tool registry, which imports the catalog:
 * a cycle the ../../dependencies layer must not re-introduce).
 *
 * Default: `<data dir>/packages`. Override: `JARELA_PACKAGES_DIR`.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataDir } from "@/lib/db/data-dir";

export function getPackagesDir(): string {
  const raw = process.env.JARELA_PACKAGES_DIR;
  if (raw && raw.trim().length > 0) {
    return raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
  }
  const packagesDir = join(getDataDir(), "packages");
  mkdirSync(packagesDir, { recursive: true });
  return packagesDir;
}

export function getManifestsDir(): string {
  return join(getPackagesDir(), "manifests");
}
