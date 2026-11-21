/**
 * Deterministic tier of the prompt-behaviour suite.
 *
 * These assertions run on every prompt change and need no model key. They check
 * the two things that make a prompt correct in a way tests can prove:
 *
 * 1. the decision the prompt is supposed to carry is still present verbatim
 *    (`promptAnchors`), and
 * 2. the declared expectation is actually satisfiable and actually falsifiable —
 *    the right tool is executable, the wrong tool is executable too, and the
 *    expected arguments validate against the tool's real schema.
 *
 * A scenario whose wrong answer is impossible proves nothing, so that is a
 * failure here rather than a skipped check.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarela-prompt-eval-"));
process.env.JARELA_DB_DIR = root;
process.env.HOME = root;
process.env.USERPROFILE = root;

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* a held handle must not fail the suite */
  }
});

const { PROMPT_SCENARIOS, findScenario } = await import("./scenarios");
const { promptScenarioSchema } = await import("./types");
const { buildScenarioPrompt, listedToolNames } = await import("./assemble");
const { getAllToolsAsync, getAllToolCatalogAsync } = await import("@/lib/tools");

interface SchemaLike {
  safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
}

const toolsByName = new Map<string, SchemaLike>();
for (const tool of await getAllToolsAsync()) {
  const schema = (tool as unknown as { schema?: SchemaLike }).schema;
  if (schema) toolsByName.set(tool.name, schema);
}
const catalogNames = new Set((await getAllToolCatalogAsync()).map((entry) => entry.name));

// Assemble each scenario's prompt once; the assertions below read the same text
// the model would receive.
const assembledPrompts = new Map<string, Awaited<ReturnType<typeof buildScenarioPrompt>>>();
for (const scenario of PROMPT_SCENARIOS) {
  assembledPrompts.set(scenario.id, await buildScenarioPrompt(scenario));
}

describe("scenario catalogue", () => {
  it("declares every scenario in a shape the runner can execute", () => {
    expect(PROMPT_SCENARIOS.length).toBeGreaterThanOrEqual(4);
    const ids = PROMPT_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size, `duplicate scenario id in [${ids.join(", ")}]`).toBe(ids.length);

    for (const scenario of PROMPT_SCENARIOS) {
      expect(() => promptScenarioSchema.parse(scenario), scenario.id).not.toThrow();
      expect(findScenario(scenario.id), `${scenario.id}: findScenario`).toBe(scenario);
      expect(scenario.judge.hardFailures.length, `${scenario.id}: hard failures`).toBeGreaterThan(0);

      const criterionIds = scenario.judge.criteria.map((criterion) => criterion.id);
      expect(new Set(criterionIds).size, `${scenario.id}: duplicate criterion ids`).toBe(criterionIds.length);
      for (const criterion of scenario.judge.criteria) {
        expect(criterion.weight, `${scenario.id}/${criterion.id}: weight`).toBeGreaterThan(0);
      }

      // The live tier feeds this back as the only evidence, so it must be JSON.
      expect(() => JSON.parse(scenario.expect.toolResultFixture), `${scenario.id}: toolResultFixture`).not.toThrow();
      for (const [tool, result] of Object.entries(scenario.expect.toolResults)) {
        expect(() => JSON.parse(result), `${scenario.id}: toolResults.${tool}`).not.toThrow();
      }
      for (const [tool, sequence] of Object.entries(scenario.expect.toolResultSequence)) {
        for (const [index, result] of sequence.entries()) {
          expect(() => JSON.parse(result), `${scenario.id}: toolResultSequence.${tool}[${index}]`).not.toThrow();
        }
      }
      if (scenario.bindOnly.length > 0) {
        for (const name of scenario.bindOnly) {
          expect(catalogNames, `${scenario.id}: bindOnly names unregistered tool ${name}`).toContain(name);
        }
      }
    }
  });

  it("declares a realistic conversation: follow-ups have their evidence, tool turns answer a call", () => {
    for (const scenario of PROMPT_SCENARIOS) {
      const declared = new Set<string>();
      for (const [index, turn] of scenario.prior.entries()) {
        const where = `${scenario.id} prior[${index}]`;
        if (turn.role === "assistant" && turn.tool_calls.length > 0) {
          // A tool call with no result in the history makes the follow-up
          // unanswerable, which a real transcript never is.
          const answered = turn.tool_calls.every((call) =>
            scenario.prior.slice(index + 1).some((later) => later.role === "tool" && later.tool_call_id === call.id));
          expect(answered, `${where}: a tool call has no matching tool result`).toBe(true);
          for (const call of turn.tool_calls) declared.add(call.id);
        }
        if (turn.role === "tool") {
          expect(turn.tool_call_id, `${where}: tool turn needs a tool_call_id`).toBeTruthy();
          expect(declared, `${where}: answers a tool call that was never made`).toContain(turn.tool_call_id);
        }
        if (turn.role === "user" || turn.role === "tool") {
          expect(turn.tool_calls, `${where}: only assistant turns may call tools`).toEqual([]);
        }
      }
      // The request must not name the tool it is supposed to select; that would
      // turn the check into a transcription exercise.
      for (const name of scenario.expect.tools) {
        expect(scenario.request.includes(name), `${scenario.id}: request names "${name}" explicitly`).toBe(false);
      }
    }
  });

  it("names only tools that exist in the registry", () => {
    for (const scenario of PROMPT_SCENARIOS) {
      for (const name of [...scenario.expect.tools, ...scenario.expect.forbidden, ...scenario.agentTools]) {
        expect(catalogNames, `${scenario.id}: ${name} is not registered`).toContain(name);
      }
    }
  });

  it("declares an expectation and a disallowed alternative that do not overlap", () => {
    for (const scenario of PROMPT_SCENARIOS) {
      const overlap = scenario.expect.tools.filter((name) => scenario.expect.forbidden.includes(name));
      expect(overlap, `${scenario.id}: a tool cannot be both expected and forbidden`).toEqual([]);
      if (scenario.expect.requireToolCall) {
        expect(scenario.expect.tools.length, `${scenario.id}: requires a call but expects no tool`).toBeGreaterThan(0);
      }
    }
  });
});

describe.each(PROMPT_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
  "prompt contract: %s",
  (_, scenario) => {
    const assembled = assembledPrompts.get(scenario.id)!;

    it("keeps the decision rule the scenario depends on", () => {
      for (const anchor of scenario.promptAnchors) {
        expect(
          assembled.prompt.includes(anchor),
          `${scenario.id}: assembled prompt lost the anchor "${anchor}". ` +
            "Reword it in the same change in lib/agents/prompt-eval/scenarios.ts only if the new wording still carries this decision.",
        ).toBe(true);
      }
    });

    it("keeps the expected tools executable and the alternatives reachable", () => {
      const listed = new Set(listedToolNames(assembled.prompt));
      // A narrowed binding leaves tools reachable through invoke_tool; those
      // still count as reachable for a scenario that expects the proxy.
      const viaProxy = new Set(
        assembled.permissionMap
          .filter((entry) => entry.permission_reason === "proxy_only")
          .map((entry) => entry.name),
      );
      const reachable = (name: string) => listed.has(name) || viaProxy.has(name);

      for (const name of scenario.expect.tools) {
        expect(reachable(name), `${scenario.id}: ${name} must be executable or proxy-reachable`).toBe(true);
      }
      // A forbidden tool that is not reachable turns the scenario into a
      // tautology: the model could not have chosen it.
      for (const name of scenario.expect.forbidden) {
        expect(reachable(name), `${scenario.id}: forbidden tool ${name} is not reachable, so the scenario proves nothing`).toBe(true);
      }
      if (scenario.expect.proxiedTool) {
        expect(viaProxy.has(scenario.expect.proxiedTool), `${scenario.id}: ${scenario.expect.proxiedTool} must be proxy_only`).toBe(true);
      }
    });

    it("declares arguments the real tool schema accepts, and rejects a wrong shape", () => {
      const { validArgs, argumentKeys, tools, proxiedTool } = scenario.expect;
      // A proxied expectation describes the invoke_tool call itself.
      const toolName = proxiedTool ? "invoke_tool" : tools[0];
      if (!validArgs) {
        // Only runtime-derived enums omit it; the argument keys are still checked.
        expect(argumentKeys.length, `${scenario.id}: declare validArgs or argumentKeys`).toBeGreaterThan(0);
        return;
      }
      const schema = toolsByName.get(toolName);
      expect(schema, `${scenario.id}: ${toolName} exposes no argument schema`).toBeDefined();

      const accepted = schema!.safeParse(validArgs);
      expect(
        accepted.success,
        `${scenario.id}: the declared validArgs are rejected by ${toolName}: ` +
          (accepted.error?.issues.map((issue) => issue.message).join("; ") ?? ""),
      ).toBe(true);

      // A proxied call must also satisfy the target's schema, or the model
      // would be coached into a call the runtime rejects.
      if (proxiedTool) {
        const targetSchema = toolsByName.get(proxiedTool);
        expect(targetSchema, `${scenario.id}: ${proxiedTool} exposes no argument schema`).toBeDefined();
        const args = (validArgs as { args?: unknown }).args;
        if (args !== undefined) {
          const targetAccepted = targetSchema!.safeParse(args);
          expect(
            targetAccepted.success,
            `${scenario.id}: proxied args are rejected by ${proxiedTool}: ` +
              (targetAccepted.error?.issues.map((issue) => issue.message).join("; ") ?? ""),
          ).toBe(true);
        }
      }

      // At least one obviously malformed argument must be refused at the
      // boundary, so a mistaken call is caught instead of executed.
      const rejectedSomewhere = argumentKeys.some((key) => {
        const mutated = { ...validArgs, [key]: { __prompt_eval_invalid: true } };
        return !schema!.safeParse(mutated).success;
      });
      expect(rejectedSomewhere, `${scenario.id}: ${toolName} accepts every malformed argument shape`).toBe(true);
    });
  },
);
