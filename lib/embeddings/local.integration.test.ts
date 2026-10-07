import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL_ID } from "./constants";
import { embedLocally } from "./local";

const localModelPresent = existsSync(join(
  process.cwd(),
  ".jarela-assets",
  "local-embedding",
  LOCAL_EMBEDDING_MODEL_ID,
  "onnx",
  "model_quantized.onnx",
));

describe.skipIf(!localModelPresent)("bundled local embedding model", () => {
  it("embeds long local text without truncating later token windows", async () => {
    const text = Array.from({ length: 900 }, (_, index) => `section${index} contains searchable local documentation`).join(" ");
    const [vector] = await embedLocally([text], "passage");

    expect(vector).toHaveLength(LOCAL_EMBEDDING_DIMENSIONS);
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 5);
  });

  it("matches an English passage for a French query", async () => {
    const [queryVector] = await embedLocally(["Quelle est la capitale de la France?"], "query");
    const [matchingPassage] = await embedLocally(["The capital city of France is Paris."], "passage");
    const [unrelatedPassage] = await embedLocally(["Bananas are a good source of potassium."], "passage");
    const similarity = (left: number[], right: number[]) =>
      left.reduce((sum, value, index) => sum + value * right[index], 0);

    expect(similarity(queryVector, matchingPassage)).toBeGreaterThan(
      similarity(queryVector, unrelatedPassage),
    );
  });
});
