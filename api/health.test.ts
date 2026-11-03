import { afterEach, expect, it, vi } from "vitest";
import { fetchHealthDetails } from "./health";

afterEach(() => vi.unstubAllGlobals());

it("coalesces concurrent deep diagnostic requests", async () => {
  let respond!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
  vi.stubGlobal("fetch", fetch);

  const first = fetchHealthDetails();
  const second = fetchHealthDetails();
  expect(fetch).toHaveBeenCalledOnce();
  respond(new Response(JSON.stringify({
    status: "ok",
    agents: ["agent-a"],
    crypto: { source: "keychain" },
  }), { status: 200, headers: { "content-type": "application/json" } }));

  await expect(Promise.all([first, second])).resolves.toEqual([
    { agents: ["agent-a"], crypto: { source: "keychain" } },
    { agents: ["agent-a"], crypto: { source: "keychain" } },
  ]);
  expect(fetch).toHaveBeenCalledWith("/api/v1/health", expect.objectContaining({ cache: "no-store" }));
  expect(fetch).toHaveBeenCalledOnce();
});
