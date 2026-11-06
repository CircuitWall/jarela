import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { getProviderMock, invokeMock } = vi.hoisted(() => ({
  getProviderMock: vi.fn(),
  invokeMock: vi.fn(),
}));
vi.mock("@/lib/providers", () => ({ getProvider: getProviderMock }));

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-anti-halluc-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  buildClassifierUserMessage,
  classifyStall,
  parseVerdict,
  resolveDetector,
  summarizeRecentActionHistory,
  SYSTEM_PROMPT,
} = await import("./hallucination-classifier");
const { upsertModelConfig, deleteModelConfig } = await import("@/lib/stores/model-config");
const { resetConfigCache } = await import("@/lib/env/config");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function setEnv(key: string, value: string | undefined): string | undefined {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  resetConfigCache();
  return prev;
}

describe("parseVerdict", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseVerdict('{"stalled": true, "reason": "no write tool called"}'))
      .toEqual({ stalled: true, reason: "no write tool called" });
  });

  it("parses stalled=false", () => {
    expect(parseVerdict('{"stalled": false, "reason": "tool ran"}'))
      .toEqual({ stalled: false, reason: "tool ran" });
  });

  it("strips a markdown code fence wrapping", () => {
    const wrapped = '```json\n{"stalled": true, "reason": "ok"}\n```';
    expect(parseVerdict(wrapped)).toEqual({ stalled: true, reason: "ok" });
  });

  it("extracts the verdict object even with surrounding prose", () => {
    const noisy = 'The model responded: {"stalled": true, "reason": "narration only"} — done.';
    expect(parseVerdict(noisy)).toEqual({ stalled: true, reason: "narration only" });
  });

  it("returns null on empty / whitespace input", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("   ")).toBeNull();
  });

  it("returns null when the JSON is malformed", () => {
    expect(parseVerdict('{"stalled": true,')).toBeNull();
    expect(parseVerdict("not json at all")).toBeNull();
  });

  it("returns null when stalled is not a boolean", () => {
    expect(parseVerdict('{"stalled": "yes", "reason": "stringly"}')).toBeNull();
    expect(parseVerdict('{"stalled": 1, "reason": "numbery"}')).toBeNull();
  });

  it("tolerates missing reason (uses empty string)", () => {
    expect(parseVerdict('{"stalled": true}')).toEqual({ stalled: true, reason: "" });
  });

  it("trims a long reason to 200 chars", () => {
    const longReason = "x".repeat(500);
    const r = parseVerdict(`{"stalled": false, "reason": "${longReason}"}`);
    expect(r?.reason.length).toBe(200);
  });

  it("ignores extra unknown fields", () => {
    expect(parseVerdict('{"stalled": true, "reason": "ok", "confidence": 0.7}'))
      .toEqual({ stalled: true, reason: "ok" });
  });
});

describe("classifyStall", () => {
  it("returns action and citation findings from one invocation and resolves markers in code", async () => {
    upsertModelConfig("combined-checker", "openai", "gpt-4o-mini", { api_key: "sk-test" }, false);
    invokeMock.mockResolvedValue({ text: JSON.stringify({
      stalled: false, reason: "", claims: [
        { text: "Supported claim", marker: 1, impact: "high", reason: "matched" },
        { text: "Unknown source", marker: 99, impact: "med", reason: "unknown" },
        { text: "Invented marker", marker: 2, impact: "low", reason: "matched" },
      ],
    }) });
    getProviderMock.mockReturnValue({ invoke: invokeMock });
    try {
      const verdict = await classifyStall("Supported claim [1]. Unknown source [99].", {
        toolNames: [], successfulToolNames: [], toolResultSummaries: [],
      }, "combined-checker", undefined, [
        { n: 1, label: "Example", href: "https://example.com" },
        { n: 2, label: "Other", href: "https://example.org" },
      ]);
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(verdict?.citations?.claims).toMatchObject([
        { marker: 1, verified: true, link: "https://example.com" },
        { marker: 99, verified: false, link: null },
        { marker: 2, verified: false, link: null },
      ]);
    } finally {
      deleteModelConfig("combined-checker");
      invokeMock.mockReset();
      getProviderMock.mockReset();
    }
  });

  it("verifies a claim cited via an inline Markdown link, not just a bracket marker", async () => {
    upsertModelConfig("inline-link-checker", "openai", "gpt-4o-mini", { api_key: "sk-test" }, false);
    invokeMock.mockResolvedValue({ text: JSON.stringify({
      stalled: false, reason: "", claims: [
        { text: "Supported claim", marker: 1, impact: "high", reason: "matched via inline link" },
      ],
    }) });
    getProviderMock.mockReturnValue({ invoke: invokeMock });
    try {
      // PRIMARY citation format per the drafting prompt: no literal "[1]"
      // bracket anywhere in the text, only an inline Markdown link to the
      // source's URL.
      const verdict = await classifyStall("Supported claim [see here](https://example.com/path).", {
        toolNames: [], successfulToolNames: [], toolResultSummaries: [],
      }, "inline-link-checker", undefined, [
        { n: 1, label: "Example", href: "https://example.com/path" },
      ]);
      expect(verdict?.citations?.claims).toMatchObject([
        { marker: 1, verified: true, link: "https://example.com/path" },
      ]);
    } finally {
      deleteModelConfig("inline-link-checker");
      invokeMock.mockReset();
      getProviderMock.mockReset();
    }
  });

  it("reports an unavailable audit if the citation result is malformed", async () => {
    upsertModelConfig("combined-malformed", "openai", "gpt-4o-mini", { api_key: "sk-test" }, false);
    invokeMock.mockResolvedValue({ text: '{"stalled":false,"reason":"ok"}' });
    getProviderMock.mockReturnValue({ invoke: invokeMock });
    try {
      await expect(classifyStall("Answer", {
        toolNames: [], successfulToolNames: [], toolResultSummaries: [],
      }, "combined-malformed", undefined, [])).resolves.toBeNull();
    } finally {
      deleteModelConfig("combined-malformed");
      invokeMock.mockReset();
      getProviderMock.mockReset();
    }
  });

  it("sends successful reads and writes with their result evidence to the model", async () => {
    upsertModelConfig("action-checker", "openai", "gpt-4o-mini", { api_key: "sk-test" }, false);
    invokeMock.mockResolvedValue({ text: '{"stalled":false,"reason":"result supports the update"}' });
    getProviderMock.mockReturnValue({ invoke: invokeMock });
    try {
      await expect(classifyStall("I read the file and updated it.", {
        toolNames: ["file_read", "file_edit"],
        successfulToolNames: ["file_read", "file_edit"],
        toolResultSummaries: ["file_read: found requested section", "file_edit: updated 1 file"],
        recentRunEvidence: "Assistant: I checked the earlier version. Tool results: file_read: found draft",
      }, "action-checker")).resolves.toEqual({
        stalled: false,
        reason: "result supports the update",
      });

      const messages = invokeMock.mock.calls[0][1] as Array<{ role: string; content: string }>;
      expect(messages[0].content).toContain("not proof of an action or factual accuracy");
      expect(messages[1].content).toContain('"file_read","file_edit"');
      expect(messages[1].content).toContain("file_edit: updated 1 file");
      expect(messages[1].content).toContain("Recent completed turns in this thread");
    } finally {
      deleteModelConfig("action-checker");
      invokeMock.mockReset();
      getProviderMock.mockReset();
    }
  });

  it("constructs an advisory evidence message without treating successful tool names as proof", () => {
    const message = buildClassifierUserMessage("I marked the message read.", {
      toolNames: ["outlook_search"],
      successfulToolNames: ["outlook_search"],
      toolResultSummaries: ["outlook_search: []"],
    });
    expect(message).toContain("Current-turn successful tools");
    expect(message).toContain("outlook_search: []");
    expect(SYSTEM_PROMPT).toContain("A tool name alone is not evidence");
    expect(SYSTEM_PROMPT).toContain("If evidence is inconclusive, do not flag the turn.");
    expect(SYSTEM_PROMPT).toContain("when citation auditing is enabled");
  });

  it("keeps the tool and recent-run evidence section bounded", () => {
    const message = buildClassifierUserMessage("I checked the result.", {
      toolNames: Array.from({ length: 20 }, (_, index) => `tool_${index}`),
      successfulToolNames: Array.from({ length: 20 }, (_, index) => `tool_${index}`),
      toolResultSummaries: Array.from({ length: 20 }, () => "r".repeat(240)),
      recentRunEvidence: "h".repeat(5_000),
    });
    const evidence = message.split("\n\nAssistant text")[0];
    expect(evidence.length).toBeLessThanOrEqual(1400);
    expect(evidence).toContain("Recent completed turns in this thread");
    expect(evidence).toContain("h".repeat(100));
  });

  it("clips very long assistant replies while preserving their start and ending", () => {
    const text = `${"a".repeat(4_000)}MIDDLE${"z".repeat(4_000)}`;
    const message = buildClassifierUserMessage(text, {
      toolNames: [],
      successfulToolNames: [],
      toolResultSummaries: [],
    });
    expect(message).toContain("[...middle omitted...]");
    expect(message).toContain("middle clipped");
    expect(message).toContain("a".repeat(20));
    expect(message).toContain("z".repeat(20));
  });

  it("includes only recent completed assistant turns and their bounded tool results", () => {
    const summary = summarizeRecentActionHistory([
      {
        seq: 1,
        msg_id: "older",
        thread_id: "thread",
        role: "assistant",
        content: "Oldest action.",
        created_at: "2025-12-31",
        transcript_status: "completed",
        status_reason: null,
        tool_events: null,
      },
      {
        seq: 2,
        msg_id: "old",
        thread_id: "thread",
        role: "assistant",
        content: "Old action.",
        created_at: "2026-01-01",
        transcript_status: "completed",
        status_reason: null,
        tool_events: null,
      },
      {
        seq: 3,
        msg_id: "live",
        thread_id: "thread",
        role: "assistant",
        content: "Still working.",
        created_at: "2026-01-02",
        transcript_status: "in_progress",
        status_reason: null,
        tool_events: null,
      },
      {
        seq: 4,
        msg_id: "recent",
        thread_id: "thread",
        role: "assistant",
        content: "I read the document and found the requested section.",
        created_at: "2026-01-03",
        transcript_status: "completed",
        status_reason: null,
        tool_events: JSON.stringify([
          { id: "read-1", phase: "call", name: "file_read", payload: { path: "doc.md" } },
          { id: "read-1", phase: "result", name: "file_read", payload: { text: "requested section" } },
        ]),
      },
    ]);

    expect(summary).toContain("I read the document");
    expect(summary).toContain('file_read arguments: {"path":"doc.md"}; result: {"text":"requested section"}');
    expect(summary).toContain("Old action.");
    expect(summary).not.toContain("Oldest action.");
    expect(summary).not.toContain("Still working.");
  });
});

describe("resolveDetector", () => {
  // Each test pins env to a known state and restores afterwards. The
  // resolver also calls getModelConfig, so we seed real model rows when
  // a test needs the "model exists" branch.
  let prevMode: string | undefined;
  let prevModel: string | undefined;
  beforeEach(() => {
    prevMode = setEnv("JARELA_HALLUCINATION_DETECTOR_MODE", "regex");
    prevModel = setEnv("JARELA_HALLUCINATION_DETECTOR_MODEL", "");
  });
  afterAll(() => {
    setEnv("JARELA_HALLUCINATION_DETECTOR_MODE", prevMode);
    setEnv("JARELA_HALLUCINATION_DETECTOR_MODEL", prevModel);
  });

  it("returns env defaults when agent row is null", () => {
    expect(resolveDetector(null)).toEqual({ mode: "regex", modelConfigName: "" });
  });

  it("agent override 'off' wins over env default", () => {
    setEnv("JARELA_HALLUCINATION_DETECTOR_MODE", "regex");
    const out = resolveDetector({ anti_hallucination_mode: "off", anti_hallucination_model_config: null });
    expect(out.mode).toBe("off");
  });

  it("agent override 'model' uses agent's model name when DB row exists", () => {
    upsertModelConfig("test-haiku", "anthropic", "claude-haiku", { api_key: "sk-x" }, false);
    try {
      const out = resolveDetector({ anti_hallucination_mode: "model", anti_hallucination_model_config: "test-haiku" });
      expect(out).toEqual({ mode: "model", modelConfigName: "test-haiku" });
    } finally {
      deleteModelConfig("test-haiku");
    }
  });

  it("agent asks for 'model' but config doesn't exist → downgrades to regex", () => {
    const out = resolveDetector({ anti_hallucination_mode: "model", anti_hallucination_model_config: "no-such-config" });
    expect(out).toEqual({ mode: "regex", modelConfigName: "" });
  });

  it("env mode='model' with valid env model is honoured when agent has no override", () => {
    upsertModelConfig("env-classifier", "anthropic", "claude-haiku", { api_key: "sk-y" }, false);
    try {
      setEnv("JARELA_HALLUCINATION_DETECTOR_MODE", "model");
      setEnv("JARELA_HALLUCINATION_DETECTOR_MODEL", "env-classifier");
      const out = resolveDetector(null);
      expect(out).toEqual({ mode: "model", modelConfigName: "env-classifier" });
    } finally {
      deleteModelConfig("env-classifier");
    }
  });

  it("agent.model overrides env.model when both are set", () => {
    upsertModelConfig("agent-cls", "anthropic", "claude-haiku", { api_key: "sk-a" }, false);
    upsertModelConfig("env-cls", "anthropic", "claude-haiku", { api_key: "sk-b" }, false);
    try {
      setEnv("JARELA_HALLUCINATION_DETECTOR_MODEL", "env-cls");
      const out = resolveDetector({ anti_hallucination_mode: "model", anti_hallucination_model_config: "agent-cls" });
      expect(out.modelConfigName).toBe("agent-cls");
    } finally {
      deleteModelConfig("agent-cls");
      deleteModelConfig("env-cls");
    }
  });

  it("invalid stored mode value falls back to regex", () => {
    // The DB column is TEXT — a typo or a stale enum value should not
    // wedge the agent loop. Just default to regex.
    const out = resolveDetector({ anti_hallucination_mode: "report" as unknown as null, anti_hallucination_model_config: null });
    expect(out.mode).toBe("regex");
  });
});
