import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "Xenova/multilingual-e5-small";
const REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const FILES = [
  { path: "README.md", size: 1_077, gitBlobOid: "53e76ac0e07cb45ebbf3870244998e0f08632d4f" },
  { path: "config.json", size: 658, gitBlobOid: "4104f38273cc595fd9500fd243124e9f6cf383dc" },
  { path: "special_tokens_map.json", size: 167, gitBlobOid: "e0b1d18ecd0ae4ff1d47bd297d910c0cf83e504b" },
  {
    path: "tokenizer.json",
    size: 17_082_730,
    sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
  },
  { path: "tokenizer_config.json", size: 443, gitBlobOid: "059214673d9d6d2ee319411e2ffec8c024b816d5" },
  {
    path: "onnx/model_quantized.onnx",
    size: 118_308_185,
    sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
  },
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = join(root, ".jarela-assets", "local-embedding");
const modelDir = join(assetsRoot, REPOSITORY);
const stageRoot = join(root, ".jarela-assets", `.staging-${process.pid}`);
const stageAssetsRoot = join(stageRoot, "local-embedding");
const stageModelDir = join(stageAssetsRoot, REPOSITORY);
const notice = [
  "Bundled embedding model: Xenova/multilingual-e5-small",
  `Revision: ${REVISION}`,
  "License: MIT (see the upstream model card).",
  "The model supports about 100 languages and produces 384-dimensional vectors.",
  "Queries use the `query: ` prefix; indexed passages use the `passage: ` prefix.",
  "Source: https://huggingface.co/Xenova/multilingual-e5-small",
  "Base model: https://huggingface.co/intfloat/multilingual-e5-small",
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
