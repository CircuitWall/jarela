import { expect, expectTypeOf, it } from "vitest";
import {
  REMOTE_DOCUMENT_SOURCE_KINDS, documentSourcePatchSchema, documentSourceStatsSchema,
  localDocumentSourceSchema, remoteDocumentSourceSchema,
} from "./document-sources";
import type { DocumentSourceIn, DocumentSourcePatch, DocumentSourceStats } from "./types";
import type { z } from "zod";

it("derives client mutation and stats contracts from the route schemas", () => {
  expectTypeOf<z.infer<typeof localDocumentSourceSchema> | z.infer<typeof remoteDocumentSourceSchema>>()
    .toEqualTypeOf<DocumentSourceIn>();
  expectTypeOf<z.infer<typeof documentSourcePatchSchema>>().toEqualTypeOf<DocumentSourcePatch>();
  expectTypeOf<z.infer<typeof documentSourceStatsSchema>>().toEqualTypeOf<DocumentSourceStats>();
});

it.each(REMOTE_DOCUMENT_SOURCE_KINDS)("accepts the existing %s creation envelope", (kind) => {
  expect(remoteDocumentSourceSchema.parse({ kind, label: "Synthetic source", config: { key: "value" }, ignored: true }))
    .toEqual({ kind, label: "Synthetic source", config: { key: "value" } });
});

it("preserves local defaults, nullable labels, and unknown-field stripping", () => {
  expect(localDocumentSourceSchema.parse({ path: "synthetic", extra: true })).toEqual({ path: "synthetic" });
  expect(localDocumentSourceSchema.parse({ path: "synthetic", label: null, kind: "local_folder" }))
    .toEqual({ path: "synthetic", label: null, kind: "local_folder" });
  expect(documentSourcePatchSchema.parse({})).toEqual({});
  expect(documentSourcePatchSchema.parse({ label: null, enabled: false, extra: true }))
    .toEqual({ label: null, enabled: false });
});

it("rejects malformed mutation and aggregate values", () => {
  expect(localDocumentSourceSchema.safeParse({ path: "" }).success).toBe(false);
  expect(remoteDocumentSourceSchema.safeParse({ kind: "on_demand_url", label: "Synthetic", config: {} }).success).toBe(false);
  expect(remoteDocumentSourceSchema.safeParse({ kind: "github_repo", label: "", config: {} }).success).toBe(false);
  expect(documentSourcePatchSchema.safeParse({ enabled: "yes" }).success).toBe(false);
  expect(documentSourceStatsSchema.safeParse({
    source_id: "synthetic", document_count: 1, chunk_count: -1, embedded_chunk_count: 0,
  }).success).toBe(false);
});
