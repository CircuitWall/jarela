import { SkillExecutionArtifact } from "@/lib/skills/execution-artifact";
import { syntheticToolFiles } from "./authoring-scaffold";

export function extensionArtifact(name: string, source?: string) {
  const files = syntheticToolFiles(name);
  if (source !== undefined) files[0] = { ...files[0], content: source };
  const test = files.find((file) => file.path === `${name}.test.cjs`)!.content;
  // The same reviewed assertions serve both node:test and the checked runner.
  const verify = test
    .replace('const { test } = require("node:test");\n', "")
    .replace('test("configured local synthetic service returns a checked value", async () => {', "module.exports = async () => {")
    .replace(/\n\}\);\n$/, "\n};\n");
  return SkillExecutionArtifact.fromFiles([
    ...files,
    { path: "verify.cjs", content: verify },
    { path: "run.cjs", content: '"use strict";\nrequire("./verify.cjs")().then(() => process.stdout.write(JSON.stringify({passed:true,checks:7}))).catch(() => { process.stderr.write("Fixture assertions failed"); process.exitCode=1; });\n' },
    { path: "SKILL.md", content: "# Reviewed extension fixture\nFull-trust synthetic HTTP fixture. Approval of tests never approves installation or enablement.\n" },
    { path: "execution.json", content: JSON.stringify({
      schemaVersion: 1, entrypoint: "run.cjs",
      files: [...files.map((file) => file.path), "verify.cjs", "run.cjs"],
      timeoutMs: 10000, maxOutputBytes: 1024,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: { passed: { type: "boolean", enum: [true] }, checks: { type: "integer", enum: [7] } }, required: ["passed", "checks"], additionalProperties: false },
    }) },
  ]);
}
