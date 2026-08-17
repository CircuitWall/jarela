import { describe, expect, it } from "vitest";
import { readErrorBody } from "./error";

describe("readErrorBody", () => {
  it("suppresses HTML error pages instead of returning the raw markup", async () => {
    const html = `<!DOCTYPE html><html><body>${"x".repeat(2000)}</body></html>`;
    const res = new Response(html, { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
    const body = await readErrorBody(res);
    expect(body).not.toContain("<html>");
    expect(body.length).toBeLessThan(100);
  });

  it("returns short plain-text bodies unchanged", async () => {
    const res = new Response("bad credentials", { status: 401, headers: { "content-type": "text/plain" } });
    expect(await readErrorBody(res)).toBe("bad credentials");
  });

  it("truncates long plain-text bodies", async () => {
    const longBody = "e".repeat(2000);
    const res = new Response(longBody, { status: 500, headers: { "content-type": "text/plain" } });
    const body = await readErrorBody(res);
    expect(body.length).toBeLessThan(600);
    expect(body.endsWith("…")).toBe(true);
  });

  it("falls back to statusText when the body can't be read", async () => {
    const res = new Response("irrelevant", { status: 503, statusText: "Service Unavailable" });
    await res.text(); // consume the body so the internal res.text() call throws
    expect(await readErrorBody(res)).toBe("Service Unavailable");
  });
});
