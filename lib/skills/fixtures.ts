// Representative-input fixtures for skills that pair a prompt procedure with
// a deterministic checking tool. A skill folder may contain `tests/*.json`:
//
//   { "name": "...", "tool": "validate_x", "input": {...},
//     "expect": { "ok": false, "issue_paths": ["briefing.items.0.source_ids"] } }
//
// Fixtures only ever run read-capability tools, so exercising a workflow with
// synthetic inputs can never send, write, or execute anything.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Capability } from "@/lib/tools/runtime/registry";

const FixtureSchema = z.object({
  name: z.string().trim().min(1),
  tool: z.string().trim().min(1),
  input: z.unknown(),
  expect: z.object({
    ok: z.boolean(),
    issue_paths: z.array(z.string()).optional(),
  }),
});

export type SkillFixture = z.infer<typeof FixtureSchema>;

export type FixtureToolResolver = (
  name: string,
) => { tool: { invoke: (input: never) => Promise<unknown> }; capability: Capability | undefined } | undefined;

export type FixtureResult = { name: string; passed: true } | { name: string; passed: false; reason: string };

export function loadSkillFixtures(skillDir: string): SkillFixture[] {
  const testsDir = join(skillDir, "tests");
  if (!existsSync(testsDir)) return [];
  return readdirSync(testsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(testsDir, file), "utf8"));
      } catch (err) {
        throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
      }
      const parsed = FixtureSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${file}: ${issue?.path.join(".") || "fixture"} ${issue?.message ?? "is invalid"}`);
      }
      return parsed.data;
    });
}

export async function runSkillFixture(fixture: SkillFixture, resolve: FixtureToolResolver): Promise<FixtureResult> {
  const fail = (reason: string): FixtureResult => ({ name: fixture.name, passed: false, reason });
  const resolved = resolve(fixture.tool);
  if (!resolved) return fail(`tool ${fixture.tool} is not registered`);
  if (resolved.capability !== "read") {
    return fail(`tool ${fixture.tool} is not read-only (capability: ${resolved.capability ?? "unknown"}); fixtures never run tools with side effects`);
  }

  let output: unknown;
  try {
    output = await resolved.tool.invoke(fixture.input as never);
  } catch (err) {
    return fail(`tool ${fixture.tool} threw: ${(err as Error).message}`);
  }

  let result: { ok?: unknown; issues?: Array<{ path?: unknown }> };
  try {
    result = typeof output === "string" ? JSON.parse(output) : (output as typeof result);
  } catch {
    return fail(`tool ${fixture.tool} did not return JSON`);
  }
  if (typeof result?.ok !== "boolean") return fail(`tool ${fixture.tool} did not return JSON with a boolean ok`);
  if (result.ok !== fixture.expect.ok) return fail(`expected ok=${fixture.expect.ok}, got ok=${result.ok}`);

  const reported = new Set((result.issues ?? []).map((issue) => String(issue?.path ?? "")));
  const missing = (fixture.expect.issue_paths ?? []).filter((path) => !reported.has(path));
  if (missing.length > 0) {
    return fail(`expected issue paths not reported: ${missing.join(", ")} (reported: ${[...reported].join(", ") || "none"})`);
  }
  return { name: fixture.name, passed: true };
}
