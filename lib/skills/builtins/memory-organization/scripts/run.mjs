import { planMemoryCleanup } from "./plan-cleanup.mjs";

const chunks = [];
let bytes = 0;
try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("Input exceeds 64 KiB.");
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  const result = planMemoryCleanup(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const message = error instanceof SyntaxError ? "Invalid JSON input."
    : error instanceof TypeError ? "Invalid UTF-8 input." : error.message;
  process.stderr.write(`Memory cleanup input failed: ${message}\n`);
  process.exitCode = 1;
}
