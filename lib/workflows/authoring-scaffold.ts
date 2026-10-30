export function syntheticToolFiles(name: string) {
  return [
    {
      path: `${name}.cjs`,
      content: `"use strict";
module.exports = {
  name: ${JSON.stringify(name)},
  description: "Read a value from an explicitly configured local synthetic fixture service.",
  category: "Config",
  schema: {
    type: "object", properties: { value: { type: "string", maxLength: 200 } },
    required: ["value"], additionalProperties: false
  },
  config: [{ key: "base_url", type: "string", label: "Local fixture URL", required: true }],
  async run(args, ctx) {
    if (!args || typeof args.value !== "string" || args.value.length > 200 ||
        Object.keys(args).some((key) => key !== "value")) throw new Error("Invalid fixture input");
    const raw = ctx.getConfig("base_url");
    if (!raw) throw new Error("Configure the local fixture URL before use");
    const base = new URL(raw);
    if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port ||
        base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
      throw new Error("Expected an explicit http://127.0.0.1:<port> fixture origin");
    }
    const url = new URL("/fixture", base);
    url.searchParams.set("value", args.value);
    const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: "error" });
    if (!response.ok) throw new Error("Fixture service refused the request");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Fixture service returned no body");
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4096) throw new Error("Fixture response exceeds 4096 bytes");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!result || typeof result.value !== "string" || result.value !== args.value ||
        Object.keys(result).length !== 1) throw new Error("Fixture output contract failed");
    return result;
  }
};
`,
    },
    {
      path: `${name}.test.cjs`,
      content: `"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const plugin = require(${JSON.stringify(`./${name}.cjs`)});

test("configured local synthetic service returns a checked value", async () => {
  let body;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Content-Type", "application/json");
    response.end(body ?? JSON.stringify({ value: url.searchParams.get("value") }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = "http://127.0.0.1:" + server.address().port;
    const ctx = { getConfig: () => base };
    assert.deepEqual(await plugin.run({ value: "synthetic" }, ctx), { value: "synthetic" });
    await assert.rejects(() => plugin.run({ value: 42 }, ctx), /Invalid fixture input/);
    await assert.rejects(() => plugin.run({ value: "synthetic" }, { getConfig: () => null }), /Configure/);
    await assert.rejects(() => plugin.run({ value: "synthetic" },
      { getConfig: () => "https://example.invalid" }), /fixture origin/);
    body = JSON.stringify({ value: "unexpected" });
    await assert.rejects(() => plugin.run({ value: "synthetic" }, ctx), /output contract/);
    body = "x".repeat(4097);
    await assert.rejects(() => plugin.run({ value: "synthetic" }, ctx), /4096 bytes/);
    body = Buffer.from([255]);
    await assert.rejects(() => plugin.run({ value: "synthetic" }, ctx), /encoded data/);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
`,
    },
    {
      path: "README.md",
      content: `# ${name}

This dependency-free CommonJS template reads a local synthetic service only.
It is a starting point, not an implementation of an arbitrary capability gap.

## Input / output / validation

Input: {"value":"synthetic"} (one string of at most 200 characters).
Output: {"value":"synthetic"} from an explicit loopback HTTP fixture.
Validation: bounded UTF-8/JSON, exact echoed value, no redirect, one-second timeout.
No credentials or real service/account access are needed.

## Review and test

Keep all files outside the configured tools/providers/skill repositories.
Reading these files never authorizes imports or tests. After separate code
execution authorization, use the current Node runtime to run:

    node --test ${name}.test.cjs

No package installation or lifecycle hooks are needed. Changing files invalidates
any prior review. Adapt the template only within approved scope, then retest.

## Installation and recovery

Installation is a separate full-trust code-import decision. Jarela's existing
drop-in loader imports .cjs files automatically from the configured tools
directory, so never copy drafts there. Only after exact-source review and
installation authorization, copy the single ${name}.cjs file there; never copy
the test. Configure base_url and explicitly permit the tool for the chosen agent.
Verify the actual tool result, not merely a catalog entry.

On failed update, stop using the tool and report uncertainty; do not claim
automatic rollback. Disable through the existing Tools controls, remove the
installed file only when authorized, and verify it is absent from the catalog.
Restore prior reviewed bytes only with new authorization and verification.
The artifact owner supplies support; no sandbox or compatibility certification
is implied. Never extend allowlists, weaken policy or publish automatically.
`,
    },
  ];
}
