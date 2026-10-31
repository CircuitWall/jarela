import { z } from "zod";

export const memoryValueSchema = z.object({ value: z.unknown() });

export const memoryWriteSchema = z.object({
  namespace: z.string().min(1, "namespace required"),
  key: z.string().min(1, "key required"),
  ...memoryValueSchema.shape,
});

export type MemoryWrite = z.infer<typeof memoryWriteSchema>;
