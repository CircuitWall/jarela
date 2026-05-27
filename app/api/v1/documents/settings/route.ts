import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getEmbeddingModelConfigName, setEmbeddingModelConfigName } from "@/lib/stores/app-settings";
import { getModelConfig } from "@/lib/stores/model-config";

const PutSchema = z.object({
  embedding_model_config: z.string().min(1).nullable(),
});

export async function GET() {
  return NextResponse.json({
    embedding_model_config: getEmbeddingModelConfigName(),
  });
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }
  const name = parsed.data.embedding_model_config;
  if (name && !getModelConfig(name)) {
    return NextResponse.json({ error: `unknown model config: ${name}` }, { status: 400 });
  }
  return NextResponse.json({
    embedding_model_config: setEmbeddingModelConfigName(name),
  });
}
