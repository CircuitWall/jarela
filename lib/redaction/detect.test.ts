import { describe, it, expect } from "vitest";
import { detectMatches, scanJson, shannonEntropy } from "./detect";
import { DEFAULT_REDACTION_CONFIG } from "./patterns";

// Fake fixtures — synthetic strings that match the redaction patterns
// being tested. The pre-commit secret scanner is told to ignore these
// two lines; everywhere else interpolates the constants instead of
// repeating the literal so no other line trips the scan.
const FAKE_ANT = "sk-ant-abc123def456ghi789jkl000"; // jarela-secret-ok
const FAKE_ANT_HIGH_ENTROPY = "sk-ant-aB3kQ9vXp2mR7tYn4wL8jH5sZ6cF1dG0"; // jarela-secret-ok

describe("shannonEntropy", () => {
  it("is 0 for all-same characters", () => {
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
  });
  it("is 1 for two equally-frequent chars", () => {
    expect(shannonEntropy("abababab")).toBeCloseTo(1, 5);
  });
  it("is high for diverse alphanumerics", () => {
    expect(shannonEntropy("aB3kQ9vXp2mR7tYn4wL8jH5sZ6cF1dG0")).toBeGreaterThan(4.0);
  });
});

describe("detectMatches", () => {
  const cfg = DEFAULT_REDACTION_CONFIG;

  it("finds Anthropic API keys", () => {
    const text = `set ANTHROPIC_API_KEY=${FAKE_ANT} ok`;
    const matches = detectMatches(text, cfg);
    expect(matches).toHaveLength(1);
    expect(matches[0].type_hint).toBe("anthropic_api_key");
    expect(matches[0].source).toBe("pattern");
  });

  it("validates personnummer with Luhn before matching", () => {
    const valid = detectMatches("personnummer 811218-9876", cfg);
    expect(valid.some((m) => m.type_hint === "swedish_personnummer")).toBe(true);

    const invalid = detectMatches("not a pnr 811218-9870", cfg);
    expect(invalid.some((m) => m.type_hint === "swedish_personnummer")).toBe(false);
  });

  it("does not flag plain dates as personnummer", () => {
    const matches = detectMatches("today is 2026-0612 ok", cfg);
    expect(matches.some((m) => m.type_hint === "swedish_personnummer")).toBe(false);
  });

  it("masks long high-entropy strings via heuristic", () => {
    const text = "token=aB3kQ9vXp2mR7tYn4wL8jH5sZ6cF1dG0";
    const matches = detectMatches(text, cfg);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const heur = matches.find((m) => m.source === "heuristic");
    expect(heur).toBeDefined();
    expect(heur?.type_hint).toBe("unknown_long_string");
  });

  it("does not flag git SHAs (40-hex) via heuristic", () => {
    const realSha = "1a2b3c4d5e6f7890abcdef1234567890abcdef12";
    expect(/^[a-f0-9]{40}$/.test(realSha)).toBe(true);
    const matches = detectMatches(`commit ${realSha} done`, cfg);
    expect(matches.some((m) => m.source === "heuristic")).toBe(false);
  });

  it("does not flag UUIDs via heuristic", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const matches = detectMatches(`uuid=${uuid}`, cfg);
    expect(matches.some((m) => m.source === "heuristic")).toBe(false);
  });

  it("does not flag ULIDs via heuristic", () => {
    const ulid = "01HQX7K3J9V8N2M5P6R4T1Y3W8";
    const matches = detectMatches(`run=${ulid}`, cfg);
    expect(matches.some((m) => m.source === "heuristic")).toBe(false);
  });

  it("resolves overlaps so a regex match isn't split by a heuristic match", () => {
    // The Anthropic regex will match the full key; heuristic might also
    // think part of it qualifies. We expect exactly one final match.
    const text = `key ${FAKE_ANT_HIGH_ENTROPY} done`;
    const matches = detectMatches(text, cfg);
    const inKey = matches.filter((m) => m.value.startsWith("sk-ant-"));
    expect(inKey).toHaveLength(1);
  });

  it("returns matches sorted by start", () => {
    const text = `first ${FAKE_ANT} then 811218-9876 last`;
    const matches = detectMatches(text, cfg);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].start).toBeGreaterThanOrEqual(matches[i - 1].start);
    }
  });
});

describe("scanJson", () => {
  const cfg = DEFAULT_REDACTION_CONFIG;

  it("skips values under field_name_allowlist keys", () => {
    const obj = {
      id: "aB3kQ9vXp2mR7tYn4wL8jH5sZ6cF1dG0",
      payload: `API_KEY=${FAKE_ANT}`,
    };
    const { matches } = scanJson(obj, cfg);
    expect(matches.some((m) => m.value === obj.id)).toBe(false);
    expect(matches.some((m) => m.type_hint === "anthropic_api_key")).toBe(true);
  });

  it("returns offsets that index into the produced JSON text", () => {
    const obj = { token: FAKE_ANT };
    const { text, matches } = scanJson(obj, cfg);
    expect(matches).toHaveLength(1);
    const m = matches[0];
    expect(text.slice(m.start, m.end)).toBe(obj.token);
  });

  it("walks nested objects and arrays", () => {
    const obj = {
      items: [
        { run_id: "01HQX7K3J9V8N2M5P6R4T1Y3W8", body: `key ${FAKE_ANT}` },
      ],
    };
    const { matches } = scanJson(obj, cfg);
    expect(matches.some((m) => m.type_hint === "anthropic_api_key")).toBe(true);
    expect(matches.some((m) => m.source === "heuristic")).toBe(false);
  });
});

describe("digit_run heuristic", () => {
  const cfg = DEFAULT_REDACTION_CONFIG;

  function digitRunMatches(text: string) {
    return detectMatches(text, cfg).filter(
      (m) => m.type_hint === "unknown_digit_run",
    );
  }

  it("flags credit-card-shaped runs with space separators", () => {
    const matches = digitRunMatches("card 4111 1111 1111 1111 end");
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("4111 1111 1111 1111");
  });

  it("flags credit-card-shaped runs with dash separators", () => {
    const matches = digitRunMatches("card 4111-1111-1111-1111 end");
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("4111-1111-1111-1111");
  });

  it("flags 10-digit phone numbers", () => {
    const matches = digitRunMatches("call 555-867-5309 please");
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("555-867-5309");
  });

  it("flags bare 8-digit account numbers at the boundary", () => {
    const matches = digitRunMatches("acct 12345678 done");
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("12345678");
  });

  it("does not flag 7-digit runs (below threshold)", () => {
    const matches = digitRunMatches("zip+4 1234567 ok");
    expect(matches).toHaveLength(0);
  });

  it("does not flag 4-digit PINs or years", () => {
    const matches = digitRunMatches("pin 1234, year 2026");
    expect(matches).toHaveLength(0);
  });

  it("does not flag slash-separated dates (slash is not a default separator)", () => {
    const matches = digitRunMatches("date 2026/06/19 ok");
    expect(matches).toHaveLength(0);
  });

  it("flags long bare digit runs (timestamps are an accepted false positive)", () => {
    // 14-digit YYYYMMDDhhmmss timestamps look identical to long account
    // numbers — accepted noise; agent still sees head/tail/len fingerprint.
    const matches = digitRunMatches("ts 20260619221733 ok");
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("20260619221733");
  });

  it("trims leading/trailing separators from the captured value", () => {
    const matches = digitRunMatches("acct  12345678  done");
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("12345678");
  });
});
