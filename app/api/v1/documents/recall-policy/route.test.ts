import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { defaultDocumentRecallPolicy } from "@/lib/documents/recall-policy";

const root = mkdtempSync(join(tmpdir(), "jarela-recall-policy-"));
process.env.JARELA_DB_DIR = root;
const { GET, PUT } = await import("./route");
const { setDocumentRecallPolicy, getDocumentRecallPolicy, setLocalEmbeddingsEnabled } = await import("@/lib/stores/app-settings");
const { closeDb } = await import("@/lib/db");

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  setDocumentRecallPolicy(defaultDocumentRecallPolicy());
  setLocalEmbeddingsEnabled(true);
});

function request(body: unknown) {
  return new NextRequest("http://localhost/api/v1/documents/recall-policy", {
    method: "PUT", body: JSON.stringify(body),
  });
}

describe("document recall policy", () => {
  it("persists and reads policy without probing or changing embedding settings", async () => {
    const policy = {
      topics: ["Project Atlas"], topic_similarity: 0.75,
      excluded_documents: [{ source_id: "source-1", path: "gmail://synthetic", label: "Private note" }],
    };
    expect((await PUT(request(policy))).status).toBe(200);
    expect(getDocumentRecallPolicy()).toEqual(policy);
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ policy, local_embeddings: true });
  });

  it("reports nonlocal mode for provider or automatic selection", async () => {
    setLocalEmbeddingsEnabled(false);
    expect((await (await GET()).json()).local_embeddings).toBe(false);
  });

  it.each([
    { topics: [""] },
    { topics: Array(26).fill("topic") },
    { topic_similarity: 0 },
    { topic_similarity: 1.1 },
    { excluded_documents: [{ source_id: "", path: "x", label: "x" }] },
    { unknown_setting: true },
  ])("rejects invalid policy without overwriting stored preferences: %j", async (patch) => {
    const response = await PUT(request({ ...defaultDocumentRecallPolicy(), ...patch }));
    expect(response.status).toBe(400);
    expect(getDocumentRecallPolicy()).toEqual(defaultDocumentRecallPolicy());
  });
});
