import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

const packageDir = process.cwd();
const srcFile = path.join(packageDir, "src/index.ts");
const distDir = path.join(packageDir, "dist");

if (!existsSync(srcFile)) {
  throw new Error(`Expected package entry at ${srcFile}`);
}

mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [srcFile],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  outfile: path.join(distDir, "index.js"),
  packages: "external",
});

await build({
  entryPoints: [srcFile],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  outfile: path.join(distDir, "index.cjs"),
  packages: "external",
});

execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "--project", path.join(packageDir, "tsconfig.json"), "--declaration", "--emitDeclarationOnly", "--outDir", distDir], {
  stdio: "inherit",
});
