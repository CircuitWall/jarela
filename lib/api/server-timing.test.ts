import { expect, it } from "vitest";
import { withServerTiming } from "./server-timing";

it("adds valid timing metrics to the response header", () => {
  const response = withServerTiming(Response.json({ ok: true }), [
    { name: "sql", durationMs: 1.25, description: "usage query" },
    { name: "bad metric", durationMs: 3 },
  ]);

  expect(response.headers.get("Server-Timing")).toBe('sql;dur=1.3;desc="usage query"');
});
