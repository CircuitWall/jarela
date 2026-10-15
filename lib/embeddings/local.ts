import { LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL_ID } from "./constants";
import { requireLocalModelRoot } from "./local-model";
const MAX_CONTENT_TOKENS = 500;
const TOKEN_WINDOW_OVERLAP = 32;
const INFERENCE_BATCH_SIZE = 16;

export type LocalEmbeddingTask = "query" | "passage";

interface TensorLike {
  tolist(): number[][];
}

interface TokenTensorLike {
  tolist(): Array<Array<number | bigint>>;
}

interface Tokenizer {
  (text: string, options: { add_special_tokens: false; truncation: false }): {
    input_ids: TokenTensorLike;
  };
  decode(ids: number[], options: { skip_special_tokens: true }): string;
}

interface FeatureExtractor {
  tokenizer: Tokenizer;
  (texts: string[], options: {
    pooling: "mean";
    normalize: false;
    truncation: false;
  }): Promise<TensorLike>;
}

interface WindowRef {
  textIndex: number;
  tokenCount: number;
}

const localGlobals = globalThis as typeof globalThis & {
  __jarelaLocalEmbeddingPipeline?: Promise<FeatureExtractor>;
};

async function getFeatureExtractor(): Promise<FeatureExtractor> {
  if (localGlobals.__jarelaLocalEmbeddingPipeline) return localGlobals.__jarelaLocalEmbeddingPipeline;
  // Throws (and starts the download) until the model is installed; resolve
  // it before caching so a missing model is not memoised as a failure.
  const modelRoot = requireLocalModelRoot();
  const loading = (async () => {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.localModelPath = modelRoot;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    return await pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL_ID, {
      dtype: "q8",
    }) as unknown as FeatureExtractor;
  })();
  localGlobals.__jarelaLocalEmbeddingPipeline = loading;
  loading.catch(() => {
    if (localGlobals.__jarelaLocalEmbeddingPipeline === loading) localGlobals.__jarelaLocalEmbeddingPipeline = undefined;
  });
  return loading;
}

export function splitIntoTokenWindows(
  tokenIds: readonly number[],
  windowSize = MAX_CONTENT_TOKENS,
  overlap = TOKEN_WINDOW_OVERLAP,
): number[][] {
  if (windowSize <= 0 || overlap < 0 || overlap >= windowSize) {
    throw new RangeError("token window must be positive and overlap must be smaller than the window");
  }
  const windows: number[][] = [];
  const stride = windowSize - overlap;
  for (let start = 0; start < tokenIds.length; start += stride) {
    const window = tokenIds.slice(start, start + windowSize);
    windows.push(window);
    if (start + windowSize >= tokenIds.length) break;
  }
  return windows;
}

function tokenIdsFor(text: string, tokenizer: Tokenizer): number[] {
  const encoded = tokenizer(text, { add_special_tokens: false, truncation: false });
  const rows = encoded.input_ids.tolist();
  return (rows[0] ?? []).map((id) => Number(id));
}

function normalize(vector: number[]): number[] {
  let normSquared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("local embedding contains a non-finite value");
    normSquared += value * value;
  }
  const norm = Math.sqrt(normSquared);
  if (norm === 0) throw new Error("local embedding returned a zero vector");
  return vector.map((value) => value / norm);
}

export async function embedLocally(texts: string[], task: LocalEmbeddingTask): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getFeatureExtractor();
  const sums = texts.map(() => new Array<number>(LOCAL_EMBEDDING_DIMENSIONS).fill(0));
  const weights = texts.map(() => 0);
  const windows: string[] = [];
  const windowRefs: WindowRef[] = [];

  for (let textIndex = 0; textIndex < texts.length; textIndex++) {
    const tokenIds = tokenIdsFor(texts[textIndex], extractor.tokenizer);
    const tokenWindows = splitIntoTokenWindows(tokenIds);
    for (let windowIndex = 0; windowIndex < tokenWindows.length; windowIndex++) {
      const tokenWindow = tokenWindows[windowIndex];
      windows.push(`${task}: ${extractor.tokenizer.decode(tokenWindow, { skip_special_tokens: true })}`);
      const tokenCount = tokenWindow.length - (windowIndex > 0 ? TOKEN_WINDOW_OVERLAP : 0);
      windowRefs.push({ textIndex, tokenCount });
    }
  }

  for (let offset = 0; offset < windows.length; offset += INFERENCE_BATCH_SIZE) {
    const batchWindows = windows.slice(offset, offset + INFERENCE_BATCH_SIZE);
    const vectors = (await extractor(batchWindows, {
      pooling: "mean",
      normalize: false,
      truncation: false,
    })).tolist();
    if (vectors.length !== batchWindows.length) {
      throw new Error(`local embedding returned ${vectors.length}/${batchWindows.length} vectors`);
    }
    for (let batchIndex = 0; batchIndex < vectors.length; batchIndex++) {
      const vector = vectors[batchIndex];
      if (vector.length !== LOCAL_EMBEDDING_DIMENSIONS) {
        throw new Error(`local embedding returned ${vector.length} dimensions; expected ${LOCAL_EMBEDDING_DIMENSIONS}`);
      }
      const ref = windowRefs[offset + batchIndex];
      for (let dimension = 0; dimension < vector.length; dimension++) {
        sums[ref.textIndex][dimension] += vector[dimension] * ref.tokenCount;
      }
      weights[ref.textIndex] += ref.tokenCount;
    }
  }

  return sums.map((vector, index) => {
    if (weights[index] === 0) throw new Error("cannot embed empty text with the local model");
    return normalize(vector.map((value) => value / weights[index]));
  });
}
