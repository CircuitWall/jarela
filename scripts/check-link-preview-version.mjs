#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";

const MIN_SAFE = "4.0.1";

function semverParts(version) {
  const clean = String(version).trim().split("-")[0];
  const [major = "0", minor = "0", patch = "0"] = clean.split(".");
  return [Number(major), Number(minor), Number(patch)];
}

function compareSemver(a, b) {
  const [aMaj, aMin, aPat] = semverParts(a);
  const [bMaj, bMin, bPat] = semverParts(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

async function collectVersionsFromLockfile() {
  const lockPath = path.join(process.cwd(), "package-lock.json");
  const raw = await fs.readFile(lockPath, "utf8");
  const lock = JSON.parse(raw);
  const versions = new Set();

  const rootDep = lock?.dependencies?.["link-preview-js"]?.version;
  if (typeof rootDep === "string") {
    versions.add(rootDep);
  }

  const packages = lock?.packages;
  if (packages && typeof packages === "object") {
    for (const [pkgPath, pkgMeta] of Object.entries(packages)) {
      if (!pkgPath.endsWith("node_modules/link-preview-js")) continue;
      const version = pkgMeta && typeof pkgMeta === "object" ? pkgMeta.version : undefined;
      if (typeof version === "string") {
        versions.add(version);
      }
    }
  }

  return versions;
}

async function main() {
  const versions = [...(await collectVersionsFromLockfile())].sort((a, b) => compareSemver(a, b));

  if (versions.length === 0) {
    console.log("[link-preview] PASS: link-preview-js is not installed.");
    return;
  }

  const vulnerable = versions.filter((v) => compareSemver(v, MIN_SAFE) < 0);
  if (vulnerable.length > 0) {
    console.error(
      `[link-preview] FAIL: found vulnerable link-preview-js versions: ${vulnerable.join(", ")} (< ${MIN_SAFE})`
    );
    process.exit(1);
  }

  console.log(
    `[link-preview] PASS: installed link-preview-js versions are patched: ${versions.join(", ")}`
  );
}

main().catch((error) => {
  console.error("[link-preview] Failed:", error);
  process.exit(1);
});
