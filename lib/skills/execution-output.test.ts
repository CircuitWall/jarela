import { describe, expect, it } from "vitest";
import { parseSkillExecutionManifest } from "./execution-manifest";
import { SkillExecutionOutput, SKILL_STDERR_MAX_BYTES } from "./execution-output";

function manifest(maxOutputBytes = 65536, outputSchema: unknown = { type: "string" }) {
  return parseSkillExecutionManifest(JSON.stringify({
    schemaVersion: 1, entrypoint: "entry.mjs", files: ["entry.mjs"],
    inputSchema: { type: "object", properties: {} }, outputSchema, maxOutputBytes,
  }));
}

describe("bounded skill output transport", () => {
  it("captures split UTF-8 bytes and validates the complete result only at finish", () => {
    const capture = new SkillExecutionOutput(manifest());
    const stdout = Buffer.from('"A\u{1f600}e\u0301"\r\n');
    const stderr = Buffer.from("diagnostic \u{1f600}\r\n");
    for (const byte of stdout) capture.writeStdout(Buffer.from([byte]));
    for (const byte of stderr) capture.writeStderr(Buffer.from([byte]));
    expect(capture.finish()).toEqual({
      output: "A\u{1f600}e\u0301", diagnostics: "diagnostic \u{1f600}\r\n",
      stdoutBytes: stdout.length, stderrBytes: stderr.length,
    });
  });

  it.each([1, 2, 3, 5, 8, 13, 64])("is independent of byte chunking at chunk size %i", (size) => {
    const checked = manifest(65536, { type: "object", properties: {
      value: { type: "string" },
    }, required: ["value"], additionalProperties: false });
    const bytes = Buffer.from(JSON.stringify({ value: "quote \" slash \\ newline\n\u{1f600}\u00e9" }));
    const capture = new SkillExecutionOutput(checked);
    for (let start = 0; start < bytes.length; start += size) capture.writeStdout(bytes.subarray(start, start + size));
    expect(capture.finish()).toMatchObject({ output: JSON.parse(bytes.toString("utf8")), stdoutBytes: bytes.length });
  });

  it("rejects UTF-8 BOM JSON rather than silently normalizing its transport bytes", () => {
    const capture = new SkillExecutionOutput(manifest());
    capture.writeStdout(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('"value"')]));
    expect(() => capture.finish()).toThrow(expect.objectContaining({ code: "invalid_result" }));
  });

  it("accepts exact stdout/stderr byte ceilings but never clips excess into valid JSON", () => {
    const capture = new SkillExecutionOutput(manifest(2, { type: "object", properties: {} }));
    capture.writeStdout(Buffer.from("{}"));
    capture.writeStderr(Buffer.alloc(SKILL_STDERR_MAX_BYTES, 0x20));
    expect(capture.finish()).toMatchObject({
      output: {}, stdoutBytes: 2, stderrBytes: SKILL_STDERR_MAX_BYTES,
    });
    for (const stream of ["stdout", "stderr"] as const) {
      const excess = new SkillExecutionOutput(manifest(2, { type: "object", properties: {} }));
      excess.writeStdout(Buffer.from("{}"));
      if (stream === "stderr") excess.writeStderr(Buffer.alloc(SKILL_STDERR_MAX_BYTES));
      expect(() => stream === "stdout" ? excess.writeStdout(Buffer.from(" ")) : excess.writeStderr(Buffer.from("x")))
        .toThrow(expect.objectContaining({ code: "output_limit", stream }));
      expect(() => excess.finish()).toThrow(expect.objectContaining({ code: "output_limit", stream }));
    }
  });

  it.each(["stdout", "stderr"] as const)("rejects malformed or incomplete UTF-8 on %s without replacement decoding", (stream) => {
    for (const invalid of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82]]) {
      const capture = new SkillExecutionOutput(manifest());
      const write = (chunk: Buffer) => stream === "stdout" ? capture.writeStdout(chunk) : capture.writeStderr(chunk);
      if (stream === "stderr") capture.writeStdout(Buffer.from('"ok"'));
      expect(() => {
        write(Buffer.from(invalid));
        capture.finish();
      }).toThrow(expect.objectContaining({ code: "invalid_utf8", stream }));
    }
  });

  it("rejects malformed, missing, multiple and schema-invalid results without echoing output", () => {
    for (const text of ["", '"private-output', '"private-output"\n{}', '{"private-output":1}', "1e999"]) {
      const capture = new SkillExecutionOutput(manifest());
      capture.writeStdout(Buffer.from(text));
      expect(() => capture.finish()).toThrow(expect.objectContaining({ code: "invalid_result", stream: "stdout" }));
      expect(() => capture.finish()).toThrow(/^Skill stdout failed result validation$/);
    }
  });

  it("retains the first failure even after a later valid result or another stream failure", () => {
    const capture = new SkillExecutionOutput(manifest(2));
    expect(() => capture.writeStderr(Buffer.from([0xff]))).toThrow(expect.objectContaining({ code: "invalid_utf8" }));
    expect(() => capture.writeStdout(Buffer.alloc(3))).toThrow(expect.objectContaining({ code: "invalid_utf8", stream: "stderr" }));
    expect(() => capture.finish()).toThrow(expect.objectContaining({ code: "invalid_utf8", stream: "stderr" }));
  });

  it("copies caller buffers and seals captures after finish or disposal", () => {
    const capture = new SkillExecutionOutput(manifest());
    const data = Buffer.from('"original"');
    capture.writeStdout(data);
    data.fill(0);
    expect(capture.finish().output).toBe("original");
    expect(() => capture.writeStdout(Buffer.from('"replacement"'))).toThrow(/closed/);
    expect(() => capture.finish()).toThrow(/closed/);
    capture.dispose();
    const abandoned = new SkillExecutionOutput(manifest());
    abandoned.writeStdout(Buffer.from('"partial'));
    abandoned.dispose();
    abandoned.dispose();
    expect(() => abandoned.finish()).toThrow(/closed/);
    expect(() => abandoned.writeStderr(Buffer.from("late"))).toThrow(/closed/);
  });

  it("owns its validated manifest bounds and schema instead of mutable caller objects", () => {
    const declared = manifest(4);
    const capture = new SkillExecutionOutput(declared);
    declared.maxOutputBytes = 100;
    declared.outputSchema = { type: "number" };
    capture.writeStdout(Buffer.from('"ok"'));
    expect(capture.finish().output).toBe("ok");
    const excessive = new SkillExecutionOutput(manifest(4));
    expect(() => excessive.writeStdout(Buffer.from('"long"'))).toThrow(/limit/);
  });

  it("handles byte offsets, empty chunks and Unicode byte limits independently of character count", () => {
    const capture = new SkillExecutionOutput(manifest(6));
    const bytes = Buffer.from('unused"\u00e9\u00e9"unused');
    capture.writeStdout(bytes.subarray(6, bytes.length - 6));
    capture.writeStdout(Buffer.alloc(0));
    capture.writeStderr(Buffer.alloc(0));
    expect(capture.finish()).toMatchObject({ output: "\u00e9\u00e9", stdoutBytes: 6, stderrBytes: 0 });
    const excess = new SkillExecutionOutput(manifest(6));
    expect(() => excess.writeStdout(Buffer.from('"\u00e9\u00e9\u00e9"'))).toThrow(/limit/);
  });

  it("accepts exactly 256 KiB via one-byte chunks and rejects the next byte", () => {
    const capture = new SkillExecutionOutput(manifest(256 * 1024));
    capture.writeStdout(Buffer.from('"'));
    const byte = Buffer.from("x");
    for (let index = 0; index < 256 * 1024 - 2; index++) capture.writeStdout(byte);
    capture.writeStdout(Buffer.from('"'));
    expect(capture.finish().stdoutBytes).toBe(256 * 1024);
    const excess = new SkillExecutionOutput(manifest(256 * 1024));
    excess.writeStdout(Buffer.alloc(256 * 1024, 0x20));
    expect(() => excess.writeStdout(byte)).toThrow(/limit/);
  });
});
