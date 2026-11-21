import { describe, expect, it } from "vitest";
import { decodeWav } from "./whisper";

function buildWav({
  sampleRate = 16_000,
  channels = 1,
  bitsPerSample = 16,
  audioFormat = 1,
  samples = [0, 16_384, -16_384],
}: {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  audioFormat?: number;
  samples?: number[];
} = {}): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => data.writeInt16LE(value, index * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("decodeWav", () => {
  it("decodes 16 kHz mono PCM16 into normalised floats", () => {
    const decoded = decodeWav(buildWav());
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples).toHaveLength(3);
    expect(decoded.samples[0]).toBe(0);
    expect(decoded.samples[1]).toBeCloseTo(0.5, 4);
    expect(decoded.samples[2]).toBeCloseTo(-0.5, 4);
  });

  it("rejects containers that are not PCM WAV", () => {
    expect(() => decodeWav(Buffer.from("not a wave file at all"))).toThrow(/valid WAV/);
  });

  it("rejects non-PCM, stereo and non-16-bit audio", () => {
    expect(() => decodeWav(buildWav({ audioFormat: 3 }))).toThrow(/PCM/);
    expect(() => decodeWav(buildWav({ channels: 2 }))).toThrow(/mono/);
    expect(() => decodeWav(buildWav({ bitsPerSample: 8 }))).toThrow(/16-bit/);
  });
});
