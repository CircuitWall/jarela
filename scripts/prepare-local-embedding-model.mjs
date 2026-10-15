// Verify (or download) the pinned Jarela Local embedding model into
// .jarela-assets/local-embedding. Used for source checkouts, offline bundles
// (JARELA_BUNDLE_LOCAL_EMBEDDING=1), and the npm package smoke test; installed
// apps otherwise download the model on demand (ADR-0101).
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_MODEL_REPOSITORY,
  LOCAL_MODEL_REVISION,
  ensureLocalModelAssets,
} from "../lib/embeddings/local-model-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await ensureLocalModelAssets(join(root, ".jarela-assets", "local-embedding"));
console.log(`[local-embedding] ${result} ${LOCAL_MODEL_REPOSITORY}@${LOCAL_MODEL_REVISION}`);
