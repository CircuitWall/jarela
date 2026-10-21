import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createRequestDispatcher } = require("../functions/google-oauth-proxy/router.js");

function responseRecorder() {
  return {
    code: 200,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

it("routes the legacy root and namespaced OAuth path to the same handler", () => {
  const calls = [];
  const tokenHandler = (req, res) => {
    calls.push(req.url);
    return res.status(204).send("");
  };
  const dispatch = createRequestDispatcher(new Map([
    ["/", tokenHandler],
    ["/oauth2/token", tokenHandler],
  ]));

  const legacyResponse = responseRecorder();
  const namespacedResponse = responseRecorder();
  dispatch({ method: "POST", url: "/" }, legacyResponse);
  dispatch({ method: "POST", url: "/oauth2/token" }, namespacedResponse);

  expect(calls).toEqual(["/", "/oauth2/token"]);
  expect(legacyResponse.code).toBe(204);
  expect(namespacedResponse.code).toBe(204);
});

it("returns 404 for unregistered paths", () => {
  const dispatch = createRequestDispatcher(new Map([["/", () => undefined]]));
  const response = responseRecorder();

  dispatch({ method: "POST", url: "/unregistered" }, response);

  expect(response.code).toBe(404);
  expect(response.body).toEqual({ error: "not_found" });
});
