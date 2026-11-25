import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyRoute,
  normalizeApiPath,
  validateApiDocs,
} from "./check-api-docs.mjs";

const roots = [];

function fixtureRepo(doc, routes) {
  const root = mkdtempSync(join(tmpdir(), "jarela-api-docs-"));
  roots.push(root);
  for (const [route, source] of Object.entries(routes)) {
    const absolute = join(root, "app", "api", route, "route.ts");
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, source);
  }
  const docs = join(root, "docs", "api.md");
  mkdirSync(join(docs, ".."), { recursive: true });
  writeFileSync(docs, doc);
  return root;
}

const publicRoute = "/**\n * @public — ping\n */\nexport function GET() {}\n";
const internalRoute = "export function GET() {}\n";

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("route markers", () => {
  it("distinguishes app-public, extension-public and internal routes", () => {
    expect(classifyRoute(publicRoute)).toBe("public");
    expect(classifyRoute("/**\n * @public-internal — extension\n */\n")).toBe("public-internal");
    expect(classifyRoute(internalRoute)).toBe("internal");
  });

  it("normalizes path placeholders, queries and fragments", () => {
    expect(normalizeApiPath("/api/v1/providers/{provider}/models?fresh=1")).toBe(
      "/api/v1/providers/[provider]/models",
    );
    expect(normalizeApiPath("/api/v1/redaction/#top")).toBe("/api/v1/redaction");
  });
});

describe("API contract documentation", () => {
  it("passes when public markers and headings agree", () => {
    const repo = fixtureRepo("### `GET /api/v1/ping`\n", { "v1/ping": publicRoute });
    expect(validateApiDocs(repo)).toEqual([]);
  });

  it("fails when a public route is undocumented", () => {
    const repo = fixtureRepo("# API\n", { "v1/ping": publicRoute });
    expect(validateApiDocs(repo)).toContain(
      "app/api/v1/ping/route.ts: @public route is not documented in docs/api.md -> /api/v1/ping",
    );
  });

  it("fails when a documented endpoint has no public marker", () => {
    const repo = fixtureRepo("### `GET /api/v1/ping`\n", { "v1/ping": internalRoute });
    expect(validateApiDocs(repo)).toContain(
      "docs/api.md: documented endpoint has no public marker -> /api/v1/ping (app/api/v1/ping/route.ts)",
    );
  });

  it("fails when a public route is also listed out-of-scope", () => {
    const repo = fixtureRepo(
      "### `GET /api/v1/ping`\n\n## Out of scope\n\n- `/api/v1/ping`\n",
      { "v1/ping": publicRoute },
    );
    expect(validateApiDocs(repo)).toContain(
      "docs/api.md: @public route is also listed as out-of-scope -> /api/v1/ping",
    );
  });
});
