import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "Xenova/all-MiniLM-L6-v2";
const REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const FILES = [
  { path: "README.md", size: 1_767, gitBlobOid: "980ba38150c4c24f9858f3b585a1113ab01f47a2" },
  { path: "config.json", size: 650, gitBlobOid: "72147e4ff4426ebedbfa2146c4a0999def51a313" },
  { path: "special_tokens_map.json", size: 125, gitBlobOid: "a8b3208c2884c4efb86e49300fdd3dc877220cdf" },
  { path: "tokenizer.json", size: 711_661, gitBlobOid: "c17ed520ed8438736732a54957a69306b8822215" },
  { path: "tokenizer_config.json", size: 366, gitBlobOid: "37fca74771bc76a8e01178ce3a6055a0995f8093" },
  { path: "vocab.txt", size: 231_508, gitBlobOid: "fb140275c155a9c7c5a3b3e0e77a9e839594a938" },
  {
    path: "onnx/model_quantized.onnx",
    size: 22_972_370,
    sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
  },
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = join(root, ".jarela-assets", "local-embedding");
const modelDir = join(assetsRoot, REPOSITORY);
const stageRoot = join(root, ".jarela-assets", `.staging-${process.pid}`);
const stageAssetsRoot = join(stageRoot, "local-embedding");
const stageModelDir = join(stageAssetsRoot, REPOSITORY);
const notice = [
  "Bundled embedding model: Xenova/all-MiniLM-L6-v2",
  `Revision: ${REVISION}`,
  "License: Apache-2.0 (see the Jarela distribution LICENSE file).",
  "The model is an English sentence embedder that produces 384-dimensional vectors.",
  "Source: https://huggingface.co/Xenova/all-MiniLM-L6-v2",
  "Base model: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2",
  "",
].join("\n");

function gitBlobOid(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

async function readValidAsset(file) {
  try {
    const bytes = await readFile(join(modelDir, file.path));
    if (bytes.length !== file.size) return false;
    if (file.sha256 && createHash("sha256").update(bytes).digest("hex") !== file.sha256) return false;
    if (file.gitBlobOid && gitBlobOid(bytes) !== file.gitBlobOid) return false;
    return true;
  } catch {
    return false;
  }
}

if ((await Promise.all(FILES.map(readValidAsset))).every(Boolean)) {
  await writeFile(join(modelDir, "MODEL-NOTICE.txt"), notice);
  console.log(`[local-embedding] verified ${REPOSITORY}@${REVISION}`);
  process.exit(0);
}

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageModelDir, { recursive: true });

try {
  for (const file of FILES) {
    const url = `https://huggingface.co/${REPOSITORY}/resolve/${REVISION}/${file.path}?download=true`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`download failed (${response.status}) for ${file.path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== file.size) {
      throw new Error(`size mismatch for ${file.path}: expected ${file.size}, got ${bytes.length}`);
    }
    if (file.sha256 && createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`SHA-256 mismatch for ${file.path}`);
    }
    if (file.gitBlobOid && gitBlobOid(bytes) !== file.gitBlobOid) {
      throw new Error(`Git blob hash mismatch for ${file.path}`);
    }
    const destination = join(stageModelDir, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }

  await writeFile(join(stageModelDir, "MODEL-NOTICE.txt"), notice);
  const backup = `${assetsRoot}.previous-${process.pid}`;
  await rm(backup, { recursive: true, force: true });
  try {
    await rename(assetsRoot, backup);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rename(stageAssetsRoot, assetsRoot);
  await rm(backup, { recursive: true, force: true });
  console.log(`[local-embedding] prepared ${REPOSITORY}@${REVISION}`);
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}
