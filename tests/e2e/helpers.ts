import type { APIRequestContext } from "@playwright/test";

/** Seed a mock model + agent via the public API so the app skips the
 *  first-run setup wizard. Returns the agent id. */
export async function seedMockAgent(request: APIRequestContext): Promise<{ model: string; agent: string }> {
  const modelName = "e2e-mock";
  const agentName = "E2E Mock";

  // Idempotent: upsertModelConfig uses name as the key.
  const modelRes = await request.post("/api/v1/models", {
    data: {
      name: modelName,
      provider: "mock",
      model_id: "mock-1",
      params: {},
      is_default: true,
    },
  });
  if (!modelRes.ok()) {
    throw new Error(`seed model failed: ${modelRes.status()} ${await modelRes.text()}`);
  }

  // Look up existing agents first so re-runs don't create duplicates.
  const list = await request.get("/api/v1/agents");
  if (list.ok()) {
    const existing = (await list.json()) as Array<{ id: string; name: string }>;
    const hit = existing.find((a) => a.name === agentName);
    if (hit) return { model: modelName, agent: hit.id };
  }

  const agentRes = await request.post("/api/v1/agents", {
    data: {
      name: agentName,
      identity: "A deterministic test agent backed by the mock provider.",
      instructions: "Respond exactly as the user's MOCK: directives instruct.",
      tools: [],
      model_config_name: modelName,
      is_default: true,
    },
  });
  if (!agentRes.ok()) {
    throw new Error(`seed agent failed: ${agentRes.status()} ${await agentRes.text()}`);
  }
  const body = (await agentRes.json()) as { id: string };
  return { model: modelName, agent: body.id };
}
