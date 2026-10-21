import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seed } from "./live-test.mjs";

const model = { name: "configured-model", provider: "openai", model_id: "test-model", params: {}, is_default: true };
const agent = { id: "configured-agent", name: "Configured agent", model_config_name: model.name, is_default: true };
let fetchMock;

function respond(...bodies) {
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(Response.json(body));
  }
}

function writes() {
  return fetchMock.mock.calls
    .filter(([, opts]) => opts.method)
    .map(([url, opts]) => ({ path: new URL(url).pathname, method: opts.method, body: JSON.parse(opts.body) }));
}

beforeEach(() => {
  vi.stubEnv("JARELA_SEED_FROM_PROD", "0");
  fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected seed request"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("live-test seed", () => {
  it("creates and verifies a default model and agent on a fresh database", async () => {
    const stub = { ...model, name: "live-test-model", model_id: "gpt-4o-mini" };
    respond([], stub, [stub], [], agent, [{ ...agent, model_config_name: stub.name }]);

    await seed();

    expect(writes()).toEqual([
      { path: "/api/v1/models", method: "POST", body: stub },
      {
        path: "/api/v1/agents",
        method: "POST",
        body: { name: "Live test", tools: [], model_config_name: stub.name, is_default: true },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("reuses existing defaults without creating duplicate fixtures on repeat runs", async () => {
    for (let i = 0; i < 2; i++) {
      respond([model], [model], [agent], agent, [agent]);
      await seed();
    }

    expect(writes()).toEqual(Array(2).fill({
      path: "/api/v1/agents/configured-agent",
      method: "PUT",
      body: { is_default: true, model_config_name: model.name },
    }));
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("promotes existing records when neither list has a default", async () => {
    respond([{ ...model, is_default: false }], model, [model], [{ ...agent, is_default: false }], agent, [agent]);

    await seed();

    expect(writes()).toEqual([
      {
        path: "/api/v1/models/configured-model",
        method: "PUT",
        body: { provider: model.provider, model_id: model.model_id, params: model.params, is_default: true },
      },
      {
        path: "/api/v1/agents/configured-agent",
        method: "PUT",
        body: { is_default: true, model_config_name: model.name },
      },
    ]);
  });

  it("prefers the default records over earlier non-default records", async () => {
    const otherModel = { ...model, name: "other-model", is_default: false };
    const otherAgent = { ...agent, id: "other-agent", is_default: false };
    respond([otherModel, model], [otherModel, model], [otherAgent, agent], agent, [otherAgent, agent]);

    await seed();

    expect(writes()).toEqual([{
      path: "/api/v1/agents/configured-agent",
      method: "PUT",
      body: { is_default: true, model_config_name: model.name },
    }]);
  });

  it.each([
    { before: [], method: "GET", path: "/api/v1/models" },
    { before: [[]], method: "POST", path: "/api/v1/models" },
    { before: [[{ ...model, is_default: false }]], method: "PUT", path: "/api/v1/models/configured-model" },
    { before: [[model]], method: "GET", path: "/api/v1/models" },
    { before: [[model], [model]], method: "GET", path: "/api/v1/agents" },
    { before: [[model], [model], []], method: "POST", path: "/api/v1/agents" },
    { before: [[model], [model], [agent]], method: "PUT", path: "/api/v1/agents/configured-agent" },
    { before: [[model], [model], [agent], agent], method: "GET", path: "/api/v1/agents" },
  ])("stops when $method $path fails", async ({ before, method, path }) => {
    respond(...before);
    fetchMock.mockResolvedValueOnce(Response.json({ error: "synthetic setup failure" }, { status: 500 }));

    await expect(seed()).rejects.toThrow(`seed: ${method} ${path} returned HTTP 500`);
    expect(fetchMock).toHaveBeenCalledTimes(before.length + 1);
  });

  it.each([
    { bodies: [{}], message: "expected a model list" },
    { bodies: [[model], {}], message: "expected a model list" },
    { bodies: [[model], []], message: "default model did not persist" },
    { bodies: [[model], [model], {}], message: "expected an agent list" },
    { bodies: [[model], [model], [agent], agent, {}], message: "expected an agent list" },
    { bodies: [[model], [model], [], agent, []], message: "default agent binding did not persist" },
    {
      bodies: [[model], [model], [agent], agent, [{ ...agent, model_config_name: "wrong-model" }]],
      message: "default agent binding did not persist",
    },
  ])("rejects invalid or unpersisted setup: $message", async ({ bodies, message }) => {
    respond(...bodies);

    await expect(seed()).rejects.toThrow(message);
    expect(fetchMock).toHaveBeenCalledTimes(bodies.length);
  });
});
