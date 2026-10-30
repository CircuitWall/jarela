import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkBaseline, collectSourceFiles, createBaseline, isProductionSource, MAX_FUNCTION_LINES, measureFunctions,
} from "./check-function-complexity.mjs";

function body(lines) {
  return `{\n${"  work();\n".repeat(lines - 2)}}`;
}

describe("function body measurement", () => {
  it("measures exact boundaries and ignores JSDoc", () => {
    const results = measureFunctions("example.ts", `/**\n${" * docs\n".repeat(20)} */\nfunction work() ${body(150)}`);
    expect(results[0].lines).toBe(150);
    expect(checkBaseline(results, createBaseline([]))).toEqual([]);
    expect(checkBaseline(measureFunctions("example.ts", `function work() ${body(151)}`), createBaseline([])))
      .toEqual([expect.stringContaining("151 lines (limit 150)")]);
  });

  it("uses syntax rather than braces in strings, comments, regexes, or templates", () => {
    const source = "const f = () => {\nconst a = '}'; // {\nconst b = /[{}]/;\nconst c = `}}${a}`;\n};";
    expect(measureFunctions("example.ts", source)[0].lines).toBe(5);
  });

  it("includes arrows, nested callbacks, methods, constructors, accessors and JSX", () => {
    const results = measureFunctions("example.tsx", `
      function top() { return [1].map(() => { return 1; }); }
      const arrow = async () => { return 2; };
      class Service {
        constructor() { work(); }
        async run() { return 1; }
        get value() { return 1; }
        set value(v: number) { work(v); }
      }
      const View = () => (
        <div>
          <span>Example</span>
        </div>
      );
    `);
    expect(results).toHaveLength(8);
    expect(results.map(({ id }) => id)).toContain("example.tsx::Service/run#1");
    expect(results.find(({ name }) => name === "View#1").lines).toBe(5);
  });

  it("keeps identities stable when unrelated lines move", () => {
    const text = `function work() ${body(151)}`;
    expect(measureFunctions("example.ts", text)[0].id)
      .toBe(measureFunctions("example.ts", `\n\n// moved\n${text}`)[0].id);
  });

  it("distinguishes repeated callbacks and methods in different classes", () => {
    const measurements = measureFunctions("example.ts", `
      items.map(() => { return 1; });
      items.map(() => { return 2; });
      class One { run() { return 1; } }
      class Two { run() { return 2; } }
    `);
    expect(new Set(measurements.map(({ id }) => id)).size).toBe(measurements.length);
  });

  it("fails explicitly on invalid syntax", () => {
    expect(() => measureFunctions("bad.ts", "function broken( {")).toThrow("bad.ts:");
  });
});

describe("function complexity ratchet", () => {
  const existing = measureFunctions("example.ts", `function work() ${body(160)}`);
  const baseline = createBaseline(existing);

  it("accepts existing violations without allowing growth", () => {
    expect(checkBaseline(existing, baseline)).toEqual([]);
    expect(checkBaseline(measureFunctions("example.ts", `function work() ${body(161)}`), baseline))
      .toEqual([expect.stringContaining("161 lines (limit 160)")]);
  });

  it("requires reductions and deletions to tighten the baseline", () => {
    expect(checkBaseline(measureFunctions("example.ts", `function work() ${body(155)}`), baseline))
      .toEqual([expect.stringContaining("reduce the baseline from 160 to 155")]);
    expect(checkBaseline(measureFunctions("example.ts", `function work() ${body(150)}`), baseline))
      .toEqual([expect.stringContaining("no exception")]);
    expect(checkBaseline([], baseline)).toEqual([expect.stringContaining("remove stale baseline entry")]);
  });

  it("rejects new long functions even when another exception exists", () => {
    const added = measureFunctions("new.ts", `const added = () => ${body(151)}`);
    expect(checkBaseline([...existing, ...added], baseline))
      .toEqual([expect.stringContaining("new.ts")]);
  });

  it.each([null, {}, { ...baseline, maxLines: 151 }, { ...baseline, functions: { bad: 150 } }])(
    "rejects an invalid baseline %j", (value) => {
      expect(() => checkBaseline([], value)).toThrow("Invalid function complexity baseline");
    },
  );

  it("keeps the approved threshold explicit", () => {
    expect(MAX_FUNCTION_LINES).toBe(150);
  });
});

describe("production source selection", () => {
  it("works in source archives without Git and includes new untracked source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarela-complexity-"));
    try {
      fs.mkdirSync(path.join(root, "lib"));
      fs.writeFileSync(path.join(root, "lib", "new.ts"), "export const value = 1;");
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.writeFileSync(path.join(root, "node_modules", "dependency.ts"), "not valid source");
      expect(collectSourceFiles(root)).toEqual([path.join("lib", "new.ts")]);
    } finally {
      fs.unlinkSync(path.join(root, "lib", "new.ts"));
      fs.unlinkSync(path.join(root, "node_modules", "dependency.ts"));
      fs.rmdirSync(path.join(root, "lib"));
      fs.rmdirSync(path.join(root, "node_modules"));
      fs.rmdirSync(root);
    }
  });
  it.each(["app/page.tsx", "lib/tools/tool.ts", "packages/example/src/index.mts", "instrumentation.ts"])(
    "includes %s", (file) => expect(isProductionSource(file)).toBe(true),
  );
  it.each([
    "lib/tool.test.ts", "lib/tool.spec.ts", "components/Test.test.tsx",
    "tests/e2e/page.ts", "lib/__fixtures__/large.ts", "packages/example/dist/index.ts",
    "node_modules/example/index.ts", ".next/types/routes.ts", "global.d.ts", "lib\\a.test.ts",
  ])("excludes %s", (file) => expect(isProductionSource(file)).toBe(false));
});
