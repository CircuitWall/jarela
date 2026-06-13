import { vi } from "vitest";

export type FetchCall = { url: string; init: RequestInit };
export type QueuedResponse = { status?: number; body: unknown };

export function setupFetchHarness() {
  let calls: FetchCall[] = [];
  let responses: QueuedResponse[] = [];

  function setResponses(next: QueuedResponse[]) {
    responses = [...next];
  }

  function installFetch() {
    const fake: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      calls.push({ url, init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch: ${url}`);
      const status = next.status ?? 200;
      const noBody = status === 204 || status === 205 || status === 304;
      const bodyText = noBody
        ? null
        : typeof next.body === "string"
          ? next.body
          : JSON.stringify(next.body);
      return new Response(bodyText, {
        status,
        headers: { "content-type": "application/json" },
      });
    };
    vi.stubGlobal("fetch", fake);
  }

  function reset() {
    calls = [];
    responses = [];
    installFetch();
  }

  function cleanup() {
    vi.unstubAllGlobals();
  }

  return {
    get calls() {
      return calls;
    },
    setResponses,
    reset,
    cleanup,
  };
}
