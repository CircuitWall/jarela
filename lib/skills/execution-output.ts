import { z } from "zod";
import { parseSkillExecutionManifest, type SkillExecutionManifest } from "./execution-manifest";
import { validateSkillResult, type SkillJsonValue } from "./execution-protocol";

export const SKILL_STDERR_MAX_BYTES = 16 * 1024;
type OutputStream = "stdout" | "stderr";
type OutputErrorCode = "output_limit" | "invalid_utf8" | "invalid_result" | "closed";

export class SkillExecutionOutputError extends Error {
  constructor(readonly code: OutputErrorCode, readonly stream: OutputStream | null, message: string) {
    super(message);
    this.name = "SkillExecutionOutputError";
  }
}

type Capture = {
  bytes: Buffer;
  length: number;
  decoder: TextDecoder;
};

function capture(limit: number): Capture {
  return {
    bytes: Buffer.alloc(limit),
    length: 0,
    decoder: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
  };
}

// A protocol pass is not process success or cleanup evidence. The owner must
// enforce exit, abort, timeout and tree cleanup before using a captured result.
export class SkillExecutionOutput {
  readonly #manifest: SkillExecutionManifest;
  #stdout: Capture | null;
  #stderr: Capture | null;
  #closed = false;
  #failure: SkillExecutionOutputError | null = null;

  constructor(manifest: SkillExecutionManifest) {
    this.#manifest = parseSkillExecutionManifest(JSON.stringify(manifest));
    this.#stdout = capture(this.#manifest.maxOutputBytes);
    this.#stderr = capture(SKILL_STDERR_MAX_BYTES);
  }

  writeStdout(bytes: Uint8Array): void {
    this.#write("stdout", bytes);
  }

  writeStderr(bytes: Uint8Array): void {
    this.#write("stderr", bytes);
  }

  finish(): { output: SkillJsonValue; diagnostics: string; stdoutBytes: number; stderrBytes: number } {
    this.#assertOpen();
    const stdout = this.#stdout!;
    const stderr = this.#stderr!;
    for (const [stream, value] of [["stdout", stdout], ["stderr", stderr]] as const) {
      try {
        value.decoder.decode();
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        this.#fail("invalid_utf8", stream, `Skill ${stream} must contain valid UTF-8`);
      }
    }
    let output: SkillJsonValue;
    try {
      output = validateSkillResult(this.#manifest, stdout.bytes.toString("utf8", 0, stdout.length));
    } catch (error) {
      if (!(error instanceof z.ZodError) && !(error instanceof Error)) throw error;
      this.#fail("invalid_result", "stdout", "Skill stdout failed result validation");
    }
    const result = {
      output, diagnostics: stderr.bytes.toString("utf8", 0, stderr.length),
      stdoutBytes: stdout.length, stderrBytes: stderr.length,
    };
    this.dispose();
    return result;
  }

  dispose(): void {
    this.#closed = true;
    this.#stdout?.bytes.fill(0);
    this.#stderr?.bytes.fill(0);
    this.#stdout = null;
    this.#stderr = null;
  }

  #write(stream: OutputStream, bytes: Uint8Array): void {
    this.#assertOpen();
    const value = stream === "stdout" ? this.#stdout! : this.#stderr!;
    if (bytes.byteLength > value.bytes.length - value.length) {
      this.#fail("output_limit", stream, `Skill ${stream} exceeds its byte limit`);
    }
    try {
      value.decoder.decode(bytes, { stream: true });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      this.#fail("invalid_utf8", stream, `Skill ${stream} must contain valid UTF-8`);
    }
    value.bytes.set(bytes, value.length);
    value.length += bytes.byteLength;
  }

  #assertOpen(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new SkillExecutionOutputError("closed", null, "Skill output capture is closed");
  }

  #fail(code: OutputErrorCode, stream: OutputStream, message: string): never {
    this.#failure = new SkillExecutionOutputError(code, stream, message);
    this.dispose();
    throw this.#failure;
  }
}
