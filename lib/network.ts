// Configure undici (Node's built-in fetch) to honor HTTP_PROXY / HTTPS_PROXY / NO_PROXY
// from the environment. Without this, Node fetch ignores those vars and any external
// call (DuckDuckGo, OpenAI, GitHub Copilot, Anthropic) fails on a corporate network
// even when curl works fine.
//
// Imported once from lib/db/index.ts so it runs the moment the server touches anything.
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

let configured = false;

export function ensureProxyDispatcher(): void {
  if (configured) return;
  configured = true;
  if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
}

ensureProxyDispatcher();
