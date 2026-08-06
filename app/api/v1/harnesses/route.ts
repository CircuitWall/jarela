import type { NextRequest } from "next/server";
import { z } from "zod";
import { cachedJson, createdResponse, validateBody } from "@/lib/api/responses";
import {
  createCustomHarness,
  getDefaultHarnessId,
  listAllHarnesses,
} from "@/lib/stores/harnesses";
import { HARNESS_SECTION_KEYS } from "@/lib/agents/harness/types";

const sectionSchema = z.object({
  enabled: z.boolean().optional(),
  body: z.string().optional(),
});

const sectionsSchema = z
  .object(
    Object.fromEntries(
      HARNESS_SECTION_KEYS.map((k) => [k, sectionSchema.optional()]),
    ) as Record<(typeof HARNESS_SECTION_KEYS)[number], z.ZodOptional<typeof sectionSchema>>,
  )
  .partial();

const createSchema = z.object({
  name: z.string().min(1, "name is required").max(120),
  description: z.string().max(500).optional(),
  sections: sectionsSchema.optional().default({}),
});

export function GET() {
  return cachedJson(
    {
      harnesses: listAllHarnesses(),
      default_harness_id: getDefaultHarnessId(),
    },
    5, 30,
  );
}

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, createSchema);
  if (parsed instanceof Response) return parsed;
  const harness = createCustomHarness({
    name: parsed.name,
    description: parsed.description,
    sections: parsed.sections ?? {},
  });
  return createdResponse(harness);
}
