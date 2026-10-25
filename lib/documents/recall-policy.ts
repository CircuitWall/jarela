import { z } from "zod";

export const DocumentRecallPolicySchema = z.object({
  topics: z.array(z.string().trim().min(1).max(200)).max(25),
  topic_similarity: z.number().min(0.1).max(1),
  excluded_documents: z.array(z.object({
    source_id: z.string().min(1),
    path: z.string().min(1).max(8192),
    label: z.string().min(1).max(8192),
  })).max(500),
}).strict();

export type DocumentRecallPolicy = z.infer<typeof DocumentRecallPolicySchema>;

export function defaultDocumentRecallPolicy(): DocumentRecallPolicy {
  return { topics: [], topic_similarity: 0.8, excluded_documents: [] };
}

export class DocumentExclusionUnavailableError extends Error {
  constructor() {
    super("Document search blocked: topic exclusions require compatible embeddings for every searched chunk. Check the embedding model and reindex sources, or use the user-controlled search preview override.");
    this.name = "DocumentExclusionUnavailableError";
  }
}
