import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveE2EServers, serverForWorker } from "../scripts/e2e-servers.mjs";
import { verifyE2EIsolation } from "../scripts/e2e-isolation.mjs";

test("local workers receive distinct consecutive servers", () => {
  assert.deepEqual(resolveE2EServers({}), {
    external: false,
    urls: ["http://127.0.0.1:14312", "http://127.0.0.1:14313"],
    workers: 2,
  });
  assert.deepEqual(resolveE2EServers({ JARELA_E2E_PORT: "10000", JARELA_E2E_WORKERS: "1" }).urls, ["http://127.0.0.1:10000"]);
});

test("external servers default to one worker per distinct origin", () => {
  assert.deepEqual(resolveE2EServers({ JARELA_E2E_BASE_URL: "http://localhost:4312/" }), {
    external: true, urls: ["http://localhost:4312"], workers: 1,
  });
  assert.deepEqual(resolveE2EServers({
    JARELA_E2E_BASE_URLS: "http://localhost:4312, http://localhost:4313/",
    JARELA_E2E_WORKERS: "1",
  }).urls, ["http://localhost:4312"]);
});

test("invalid or unsafe server and worker configurations fail explicitly", () => {
  for (const env of [
    { JARELA_E2E_BASE_URL: "http://localhost", JARELA_E2E_BASE_URLS: "http://localhost" },
    { JARELA_E2E_BASE_URLS: "http://localhost:80,http://localhost" },
    { JARELA_E2E_BASE_URLS: "http://localhost," },
    { JARELA_E2E_BASE_URL: "ftp://localhost" },
    { JARELA_E2E_BASE_URL: "http://localhost/path" },
    { JARELA_E2E_BASE_URL: "http://localhost", JARELA_E2E_WORKERS: "2" },
    { JARELA_E2E_WORKERS: "0" },
    { JARELA_E2E_WORKERS: "33" },
    { JARELA_E2E_PORT: "65535" },
    { JARELA_E2E_PORT: "invalid" },
  ]) {
    assert.throws(() => resolveE2EServers(env));
  }
  assert.equal(serverForWorker(["http://localhost:4312"], 0), "http://localhost:4312");
  assert.throws(() => serverForWorker(["http://localhost:4312"], 1), /No isolated E2E server/);
});

function fakeContext(store, { failRead = false, failCleanup = false } = {}) {
  const response = (ok, data) => ({ ok: () => ok, status: () => ok ? 200 : 500, json: async () => data });
  return {
    disposed: false,
    post: async (_url, { data }) => {
      const harness = { id: data.name, name: data.name };
      store.set(harness.id, harness);
      return response(true, harness);
    },
    get: async (url) => {
      if (failRead) return response(false);
      const harness = store.get(decodeURIComponent(url.split("/").at(-1)));
      return harness ? response(true, harness) : { ok: () => false, status: () => 404 };
    },
    delete: async (url) => {
      if (failCleanup) return response(false);
      store.delete(decodeURIComponent(url.split("/").at(-1)));
      return response(true);
    },
    async dispose() { this.disposed = true; },
  };
}

test("isolation probe verifies independent stores and cleans them", async () => {
  const stores = [new Map(), new Map()];
  const contexts = stores.map((store) => fakeContext(store));
  await verifyE2EIsolation(["a", "b"], async (url) => contexts[url === "a" ? 0 : 1], "probe");
  assert.ok(stores.every((store) => store.size === 0));
  assert.ok(contexts.every((context) => context.disposed));
});

test("isolation probe rejects shared storage and still cleans both probes", async () => {
  const store = new Map();
  const contexts = [fakeContext(store), fakeContext(store)];
  await assert.rejects(verifyE2EIsolation(["a", "b"], async (url) => contexts[url === "a" ? 0 : 1], "probe"), /do not have isolated storage/);
  assert.equal(store.size, 0);
  assert.ok(contexts.every((context) => context.disposed));
});

test("isolation probe reports read and cleanup errors and disposes contexts", async () => {
  const contexts = [fakeContext(new Map(), { failRead: true, failCleanup: true }), fakeContext(new Map())];
  await assert.rejects(
    verifyE2EIsolation(["a", "b"], async (url) => contexts[url === "a" ? 0 : 1], "probe"),
    (error) => error instanceof AggregateError && /read failed/.test(error.message) && /cleanup failed/.test(error.message),
  );
  assert.ok(contexts.every((context) => context.disposed));
});

test("isolation probe disposes already-created contexts if setup fails", async () => {
  const context = fakeContext(new Map());
  await assert.rejects(
    verifyE2EIsolation(["a", "b"], async (url) => {
      if (url === "b") throw new Error("context failed");
      return context;
    }, "probe"),
    /context failed/,
  );
  assert.equal(context.disposed, true);
});

test("isolation probe does not hide a falsy thrown value", async () => {
  await assert.rejects(
    verifyE2EIsolation(["a", "b"], async () => { throw null; }, "probe"),
    /E2E isolation probe failed: null/,
  );
});
