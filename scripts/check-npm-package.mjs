import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function executableFor(command) {
  if (command === "node") return process.execPath;
  return command;
}

function run(command, args, options = {}) {
  const useCmdForNpm = process.platform === "win32" && command === "npm";
  const executable = useCmdForNpm ? (process.env.ComSpec || "cmd.exe") : executableFor(command);
  const finalArgs = useCmdForNpm ? ["/d", "/s", "/c", "npm", ...args] : args;
  const result = spawnSync(executable, finalArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: options.cwd,
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${finalArgs.join(" ")} failed (exit ${result.status})\n${result.stdout}${result.stderr}${result.error?.stack ?? result.error ?? ""}`,
    );
  }
  return result.stdout;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const rootPkgPath = resolve(repoRoot, "package.json");

// Mirror what `npm publish` does via the prepublishOnly hook so the packed
// tarball reflects what end users will actually receive.
const originalRootPkg = readFileSync(rootPkgPath, "utf8");
let filename = null;
let extractDir = null;
try {
  run("node", ["scripts/rewrite-workspace-deps.mjs"]);
  run("node", ["scripts/prune-npm-source-maps.mjs"]);

  const packJson = run("npm", ["pack", "--json"]);
  const packResult = JSON.parse(packJson);
  const pack = Array.isArray(packResult)
    ? packResult[0]
    : Object.values(packResult)[0];
  if (!pack?.filename) {
    throw new Error(`npm pack --json did not return a package filename:\n${packJson}`);
  }
  filename = pack.filename;

  const maxTarballSize = 220 * 1024 * 1024;
  if (pack.size > maxTarballSize) {
    const largestFiles = pack.files
      .slice()
      .sort((left, right) => right.size - left.size)
      .slice(0, 12)
      .map(({ path, size }) => `${path} (${size} bytes)`)
      .join("; ");
    throw new Error(
      `npm tarball is ${pack.size} bytes; maximum supported size is ${maxTarballSize} bytes. Largest entries: ${largestFiles}`,
    );
  }

  const excludedStandaloneFiles = pack.files
    .map(({ path }) => path)
    .filter((path) => path.startsWith(".next/standalone/") && (
      path.endsWith(".map") ||
      path.endsWith(".wasm") ||
      path.startsWith(".next/standalone/node_modules/onnxruntime-node/") ||
      path.startsWith(".next/standalone/node_modules/onnxruntime-web/")
    ));
  if (excludedStandaloneFiles.length > 0) {
    throw new Error(
      `npm tarball contains excluded standalone assets: ${excludedStandaloneFiles.join(", ")}`,
    );
  }

  const listing = run("tar", ["-tf", filename])
    .split(/\r?\n/)
    .filter(Boolean);

  const required = [
    "package/.next/standalone/server.js",
    "package/.next/standalone/node_modules/@huggingface/transformers/package.json",
    // The PWA manifest is a route now (ADR-0077), not a static public/ file.
    "package/.next/standalone/.next/server/app/manifest.webmanifest/route.js",
    "package/package.json",
    "package/scripts/jarela-bin.mjs",
    "package/scripts/backup.mjs",
    "package/scripts/update.mjs",
    "package/scripts/service-install.mjs",
    "package/scripts/first-run-prompt.mjs",
    "package/scripts/start-prod.mjs",
    "package/scripts/prepare-local-embedding-model.mjs",
    "package/lib/embeddings/local-model-assets.mjs",
    "package/lib/embeddings/fetch-with-retry.mjs",
    "package/scripts/run-workspace-script-if-present.mjs",
    "package/scripts/prune-npm-source-maps.mjs",
    // The extension rebranding step (ADR-0077) is only reachable by an
    // overlay if both the script and its source tree are published.
    "package/scripts/build-extension.mjs",
    "package/browser-extension/manifest.json",
    "package/browser-extension/lib/brand.mjs",
    "package/browser-extension/scripts/generate-icons.mjs",
  ];

  for (const entry of required) {
    if (!listing.includes(entry)) {
      throw new Error(`npm tarball is missing required entry: ${entry}`);
    }
  }

  const packedTests = listing.filter((entry) =>
    entry.startsWith("package/browser-extension/") && entry.endsWith(".test.mjs"),
  );
  if (packedTests.length > 0) {
    throw new Error(
      `npm tarball ships browser-extension test files: ${packedTests.join(", ")}`,
    );
  }

  if (!listing.some((entry) => entry.startsWith("package/.next/standalone/.next/static/"))) {
    throw new Error("npm tarball is missing hydrated .next/static assets inside the standalone bundle");
  }
  if (listing.some((entry) => entry.startsWith("package/.next/standalone/.jarela-assets/"))) {
    throw new Error("npm tarball must not bundle the local embedding model; it is downloaded on first use (ADR-0101)");
  }

  const packedManifest = run("tar", ["-xOf", filename, "package/package.json"]);
  if (/"workspace:/i.test(packedManifest)) {
    throw new Error(
      "npm tarball contains literal `workspace:` dependency specs — end-user `npm install` would fail with EUNSUPPORTEDPROTOCOL",
    );
  }

  const packedPackage = JSON.parse(packedManifest);
  if (!packedPackage.dependencies?.["@huggingface/transformers"]) {
    throw new Error("npm package must install @huggingface/transformers and its Node ONNX runtime dependencies");
  }

  extractDir = mkdtempSync(join(tmpdir(), "jarela-package-"));
  const extractedPackageRoot = join(extractDir, "package");
  run("tar", ["-xf", filename, "-C", extractDir]);
  symlinkSync(
    resolve(repoRoot, "node_modules"),
    join(extractedPackageRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  run("node", ["-e", [
    'const { createRequire } = require("node:module");',
    'const { resolve, sep } = require("node:path");',
    'const root = process.cwd();',
    'const fromServer = createRequire(resolve(root, ".next/standalone/server.js"));',
    'const transformers = fromServer.resolve("@huggingface/transformers");',
    'const onnxRuntime = createRequire(transformers).resolve("onnxruntime-node");',
    'const bundledModules = `${resolve(root, ".next/standalone/node_modules")}${sep}`;',
    'if (onnxRuntime.startsWith(bundledModules)) {',
    '  throw new Error(`ONNX runtime resolved from standalone instead of installed dependencies: ${onnxRuntime}`);',
    '}',
    'require(onnxRuntime);',
  ].join("\n")], { cwd: extractedPackageRoot });
  // Fetch/verify the pinned model (cached in CI) and run it through the
  // installed ONNX runtime the package resolves.
  run("node", ["scripts/prepare-local-embedding-model.mjs"], { cwd: repoRoot });
  run("node", ["-e", [
    '(async () => {',
    '  const { env, pipeline } = await import("@huggingface/transformers");',
    `  env.localModelPath = ${JSON.stringify(join(repoRoot, ".jarela-assets", "local-embedding"))};`,
    '  env.allowRemoteModels = false;',
    '  env.allowLocalModels = true;',
    '  const extractor = await pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8" });',
    '  const result = await extractor(["passage: npm package runtime smoke test"], { pooling: "mean", normalize: true });',
    '  const vector = result.tolist()[0];',
    '  if (vector.length !== 384 || !vector.every(Number.isFinite)) throw new Error("local embedding smoke test returned an invalid vector");',
  '})().catch((error) => { console.error(error); process.exitCode = 1; });',
  ].join("\n")], { cwd: extractedPackageRoot });
  run("npm", ["run", "packages:build", "--silent"], { cwd: extractedPackageRoot });

  console.log(`[npm-package] ok: ${filename} contains runnable standalone bundle`);
} finally {
  writeFileSync(rootPkgPath, originalRootPkg);
  if (filename) rmSync(filename, { force: true });
  if (extractDir) rmSync(extractDir, { recursive: true, force: true });
}
