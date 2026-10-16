import { describe, expect, it, vi } from "vitest";

const DEFAULT_ROWS = [
  { seq: 10, role: "user", content: "hello", created_at: "2026-09-25T10:00:00.000Z" },
  { seq: 11, role: "assistant", content: "hi", created_at: "2026-09-25T10:00:01.000Z" },
];

const state = vi.hoisted(() => ({
  thread: {
    thread_id: "thread-1",
    hot_since: null as string | null,
    hot_since_seq: null as number | null,
    warm_summary: null as string | null,
    warm_summary_before: null as string | null,
    warm_summary_before_seq: null as number | null,
    message_count: 2,
  },
  warmSummaryLimit: 2,
  commits: [] as Array<{ hotSince: string; summary: string }>,
  rows: [] as unknown[],
  automationRows: {} as Record<string, unknown[]>,
  channelSummaries: {} as Record<string, { thread_id: string; channel: string; summary: string; summary_before: string | null; summary_before_seq: number | null; computed_at: string; topics?: string | null }>,
  topicSegments: [] as unknown[],
  provider: {} as unknown,
}));
state.rows = DEFAULT_ROWS;

vi.mock("@/lib/stores/threads", () => ({
  getThread: () => state.thread,
  getRecentMessagesWindow: () => state.rows,
  getThreadMessageBySeq: (_threadId: string, seq: number) => [
    ...state.rows as Array<{ seq: number; created_at: string }>,
    ...Object.values(state.automationRows).flat() as Array<{ seq: number; created_at: string }>,
  ].find((row) => row.seq === seq) ?? null,
  commitThreadWarmContext: (_threadId: string, input: { hotSince: string; hotSinceSeq?: number; summary: string; channelSummaries?: Array<{ channel: string; summary: string; topics?: string | null }> }) => {
    state.commits.push({ hotSince: input.hotSince, summary: input.summary });
    state.thread = {
      ...state.thread,
      hot_since: input.hotSince,
      hot_since_seq: input.hotSinceSeq ?? 1,
      warm_summary: input.summary,
      warm_summary_before: input.hotSince,
      warm_summary_before_seq: input.hotSinceSeq ?? 1,
    };
    for (const channelSummary of input.channelSummaries ?? []) {
      state.channelSummaries[channelSummary.channel] = {
        thread_id: _threadId,
        channel: channelSummary.channel,
        summary: channelSummary.summary,
        summary_before: input.hotSince,
        summary_before_seq: input.hotSinceSeq ?? 1,
        computed_at: "2026-09-25T10:00:00.000Z",
        topics: channelSummary.topics ?? null,
      };
    }
    return state.thread;
  },
  getMessagesByAutomationCategory: (threadId: string, channel: string) => state.automationRows[channel] ?? [],
  getThreadChannelSummary: (threadId: string, channel: string) => state.channelSummaries[channel] ?? null,
  listThreadChannelSummaries: () => Object.values(state.channelSummaries),
  commitThreadChannelSummary: (threadId: string, channel: string, input: { summary: string; summaryBefore: string | null; summaryBeforeSeq?: number | null; topics?: string | null }) => {
    state.channelSummaries[channel] = {
      thread_id: threadId,
      channel,
      summary: input.summary,
      summary_before: input.summaryBefore,
      summary_before_seq: input.summaryBeforeSeq ?? null,
      computed_at: "2026-09-25T10:00:00.000Z",
      topics: input.topics ?? null,
    };
  },
}));
vi.mock("@/lib/stores/agent-configs", () => ({
  getAgentConfig: () => ({ id: "agent-1", model_config_name: "model-1", warm_summary_limit: state.warmSummaryLimit }),
  getAgentTierProportions: () => null,
}));
vi.mock("@/lib/stores/model-config", () => ({
  resolveRunnableModelConfig: () => ({ name: "model-1", provider: "mock", model_id: "mock-1" }),
  getModelParams: () => ({}),
}));
vi.mock("@/lib/providers", () => ({ getProvider: () => state.provider }));
vi.mock("@/lib/stores/memory", () => ({ putMemory: () => {} }));
vi.mock("@/lib/agents/prepare/history-window", () => ({
  unwrapWarmSummary: (s: string) => ({ scope: "foreground", content: s }),
  wrapWarmSummary: (s: string) => s,
  warmSummaryMessageLimit: (limit?: number | null) => limit == null ? 50 : Math.max(0, Math.floor(limit)),
  takeRecentWarmMessages: <T>(messages: readonly T[], warmSummaryLimit?: number | null) =>
    warmSummaryLimit === 0 ? [] : messages.slice(-(warmSummaryLimit ?? 50)),
  AUTOMATION_CHANNEL_ORDER: ["scheduled_task", "watcher", "bridge"],
}));
vi.mock("@/lib/agents/conversation-summary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/conversation-summary")>();
  return {
    ...actual,
    summarizeTranscript: vi.fn(async () => ""),
    transcriptText: (c: unknown) => String(c),
    extractTopicSegments: (raw: string) => ({ body: raw, topics: state.topicSegments }),
  };
});

import { kickBoundaryCompaction, compactThreadWarmContext, pendingCompactionBoundary, pendingCompactionBoundarySeq, compactAutomationChannelWarmContext, currentChannelSummaries, isChannelSummaryFresh, isManualCompactionRunning, trackManualCompaction } from "./warm-summary-background";
import { summarizeTranscript } from "@/lib/agents/conversation-summary";

describe("trackManualCompaction", () => {
  it("reports a manual /compact as pending until it settles", async () => {
    let release!: () => void;
    const done = trackManualCompaction("thread-manual", 42, () => new Promise<void>((r) => { release = r; }));
    expect(pendingCompactionBoundarySeq("thread-manual")).toBe(42);
    expect(isManualCompactionRunning("thread-manual")).toBe(true);
    release();
    await done;
    expect(pendingCompactionBoundarySeq("thread-manual")).toBeNull();
    expect(isManualCompactionRunning("thread-manual")).toBe(false);
  });

  it("does not report automatic boundary compactions as manual", () => {
    kickBoundaryCompaction("thread-auto-only", 5);
    expect(isManualCompactionRunning("thread-auto-only")).toBe(false);
  });
});

describe("compactThreadWarmContext — seq-exact boundary (ADR-0088)", () => {
  it("excludes only rows at-or-after the boundary seq from the warm summary, even when their created_at ties the boundary (a same-millisecond tie is now possible since addMessage no longer bumps colliding timestamps)", async () => {
    // Two rows share one created_at. The boundary row is seq=11 (kept, not
    // summarized); seq=10 is the one thread-compaction.ts's pruneThreadMessages
    // will delete (rowid < 11). Before the fix, buildSummaryBefore filtered on
    // `created_at < boundary` alone — "T" < "T" is false for BOTH rows, so
    // seq=10 would be pruned without ever being folded into the summary.
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      warm_summary: null,
      warm_summary_before: null,
      message_count: 2,
    };
    state.commits = [];
    state.rows = [
      { seq: 10, role: "user", content: "first turn, about to be pruned", created_at: "2026-09-25T10:00:00.000Z" },
      { seq: 11, role: "assistant", content: "boundary turn, stays in hot window", created_at: "2026-09-25T10:00:00.000Z" },
    ] as never;

    const context = await compactThreadWarmContext("thread-1", 11, {
      allowEmptySummary: true,
    });

    expect(context).not.toBeNull();
    // Only seq=10 is below the boundary seq — it's the one row that gets
    // folded into the summary's source count. seq=11 (the boundary row
    // itself) must NOT be counted as summarized, since it survives the prune.
    expect(context?.sourceMessages).toBe(1);
  });

  it("summarizes only the configured recent warm window, leaving older transcript for embedding recall", async () => {
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      hot_since_seq: null,
      warm_summary: "stale recap of the entire transcript",
      warm_summary_before: null,
      warm_summary_before_seq: 1,
      message_count: 5,
    };
    state.commits = [];
    state.automationRows = {};
    state.channelSummaries = {};
    state.topicSegments = [{
      title: "recent topic",
      start_seq: 3,
      end_seq: 4,
      start_at: "2026-09-25T09:01:00.000Z",
      end_at: "2026-09-25T09:01:01.000Z",
      recap: "topic recap only",
      facts: [],
    }];
    state.rows = [
      { seq: 1, role: "user", content: "old embedding-only question", created_at: "2026-09-25T09:00:00.000Z" },
      { seq: 2, role: "assistant", content: "old embedding-only answer", created_at: "2026-09-25T09:00:01.000Z" },
      { seq: 3, role: "user", content: "recent warm question", created_at: "2026-09-25T09:01:00.000Z" },
      { seq: 4, role: "assistant", content: "recent warm answer", created_at: "2026-09-25T09:01:01.000Z" },
      { seq: 5, role: "user", content: "hot boundary question", created_at: "2026-09-25T09:02:00.000Z" },
    ];
    vi.mocked(summarizeTranscript).mockResolvedValueOnce("bounded warm recap");

    const context = await compactThreadWarmContext("thread-1", 5);
    const transcript = vi.mocked(summarizeTranscript).mock.calls.at(-1)?.[3] as string;

    expect(context?.sourceMessages).toBe(2);
    expect(context?.summary).toContain("recent topic");
    expect(context?.summary).toContain("topic recap only");
    expect(context?.summary).not.toContain("old embedding-only");
    expect(context?.summary).not.toContain("stale recap of the entire transcript");
    expect(context?.summary).not.toContain("hot boundary question");
    expect(transcript).not.toContain("old embedding-only");
  });

  it("disables persistent chat and automation summaries when the limit is zero", async () => {
    const previousLimit = state.warmSummaryLimit;
    const previousRows = state.rows;
    const previousAutomationRows = state.automationRows;
    state.warmSummaryLimit = 0;
    state.commits = [];
    state.rows = DEFAULT_ROWS;
    state.automationRows = {
      watcher: [
        { seq: 8, role: "assistant", content: "older watcher event", created_at: "2026-09-25T09:00:00.000Z" },
        { seq: 9, role: "assistant", content: "recent watcher event", created_at: "2026-09-25T09:01:00.000Z" },
      ],
    };
    vi.mocked(summarizeTranscript).mockClear();

    try {
      const chat = await compactThreadWarmContext("thread-1", 11, { allowEmptySummary: true });
      const automation = await compactAutomationChannelWarmContext("thread-1", "watcher", 11);

      expect(chat).toMatchObject({ summary: "", sourceMessages: 0 });
      expect(automation).toMatchObject({ summary: "", sourceMessages: 0 });
      expect(summarizeTranscript).not.toHaveBeenCalled();
    } finally {
      state.warmSummaryLimit = previousLimit;
      state.rows = previousRows;
      state.automationRows = previousAutomationRows;
    }
  });

  it("folds only messages that aged out since the last pass into the stored topics, via the compaction pipeline", async () => {
    const storedTopics = [{
      title: "Earlier topic",
      start_seq: 1,
      end_seq: 2,
      start_at: "2026-09-25T09:00:00.000Z",
      end_at: "2026-09-25T09:00:01.000Z",
      recap: "earlier recap",
      facts: [],
      message_count: 2,
      source_chars: 20,
    }];
    const previousRows = state.rows;
    const previousProvider = state.provider;
    const previousLimit = state.warmSummaryLimit;
    state.warmSummaryLimit = 50;
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      hot_since_seq: 3,
      warm_summary: "previous",
      warm_summary_before: null,
      warm_summary_before_seq: 3,
      warm_summary_topics: JSON.stringify(storedTopics),
      message_count: 6,
    } as typeof state.thread;
    state.rows = [
      { seq: 1, role: "user", content: "already summarized question", created_at: "2026-09-25T09:00:00.000Z" },
      { seq: 2, role: "assistant", content: "already summarized answer", created_at: "2026-09-25T09:00:01.000Z" },
      { seq: 3, role: "user", content: "newly aged-out question", created_at: "2026-09-25T09:01:00.000Z" },
      { seq: 4, role: "assistant", content: "newly aged-out answer", created_at: "2026-09-25T09:01:01.000Z" },
      { seq: 5, role: "user", content: "hot question", created_at: "2026-09-25T09:02:00.000Z" },
    ];
    const prompts: string[] = [];
    state.provider = {
      chat: async (_model: string, messages: Array<{ content: string }>) => {
        prompts.push(messages[1].content);
        const text = messages[0].content.includes("step 1 of 3")
          ? JSON.stringify({ groups: [{ start_seq: 3, end_seq: 4, continues: "t1", title: "Earlier topic" }] })
          : JSON.stringify({ recap: "newest detail first; earlier recap compressed", facts: [] });
        return { stream: (async function* () { yield text; })() };
      },
    };

    try {
      const context = await compactThreadWarmContext("thread-1", 5);
      expect(prompts).toHaveLength(2);
      expect(prompts.join("\n")).toContain("newly aged-out question");
      expect(prompts.join("\n")).not.toContain("already summarized question");
      expect(prompts.join("\n")).not.toContain("hot question");
      expect(context?.topics).toMatchObject([{ title: "Earlier topic", start_seq: 1, end_seq: 4, message_count: 4 }]);
      expect(context?.summary).toContain("newest detail first; earlier recap compressed");
      expect(context?.sourceMessages).toBe(4);
    } finally {
      state.rows = previousRows;
      state.provider = previousProvider;
      state.warmSummaryLimit = previousLimit;
    }
  });
});

describe("kickBoundaryCompaction", () => {
  it("commits a boundary pinned at the very first message even though there is nothing earlier to summarize", async () => {
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      warm_summary: null,
      warm_summary_before: null,
      message_count: 2,
    };
    state.commits = [];
    state.rows = DEFAULT_ROWS;

    kickBoundaryCompaction("thread-1", 10);
    await vi.waitFor(() => expect(state.commits).toHaveLength(1));

    expect(state.commits[0]).toEqual({ hotSince: "2026-09-25T10:00:00.000Z", summary: "" });
    expect(state.thread.hot_since).toBe("2026-09-25T10:00:00.000Z");
  });

  it("does not move the boundary when the model returns an unverifiable topic range", async () => {
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      hot_since_seq: null,
      warm_summary: null,
      warm_summary_before: null,
      warm_summary_before_seq: null,
      message_count: 2,
    };
    state.commits = [];
    state.rows = DEFAULT_ROWS;
    state.topicSegments = [{
      title: "forged topic",
      start_seq: 900,
      end_seq: 11,
      start_at: "2026-09-25T10:00:00.000Z",
      end_at: "2026-09-25T10:00:01.000Z",
      recap: "not grounded in source rows",
      facts: [],
    }];

    kickBoundaryCompaction("thread-1", 11);
    await vi.waitFor(() => expect(pendingCompactionBoundarySeq("thread-1")).toBeNull());

    expect(state.commits).toHaveLength(0);
    expect(state.thread.hot_since_seq).toBeNull();
  });

  // A second boundary request arriving while the first is still in flight
  // used to be silently dropped (the activeRefreshes/pendingBoundaries guard
  // just returned early) — the thread would settle on whichever boundary
  // was requested FIRST, not last, with no error and no indication the
  // second request was ignored. This is the real shape a user hits by
  // dragging the divider twice quickly, or two devices moving the same
  // thread's boundary — both legitimate, supported interactions.
  it("queues a boundary request that arrives while one is already in flight, converging on the LAST one requested", async () => {
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      warm_summary: null,
      warm_summary_before: null,
      message_count: 2,
    };
    state.commits = [];
    state.rows = DEFAULT_ROWS;
    state.topicSegments = [{
      title: "same topic",
      start_seq: 10,
      end_seq: 11,
      start_at: DEFAULT_ROWS[0].created_at,
      end_at: DEFAULT_ROWS[1].created_at,
      recap: "same topic recap",
      facts: [],
    }];

    kickBoundaryCompaction("thread-1", 10);
    // Second request arrives synchronously, before the first's queued
    // microtask has had a chance to run — this is the exact race.
    kickBoundaryCompaction("thread-1", 11);
  kickBoundaryCompaction("thread-1", 11);

    // The queued (most-recently-requested) boundary is reported, not the
    // stale one already in flight — the caller asked to move to 11:00, so
    // that's what should be reported as pending, not 10:00.
    expect(pendingCompactionBoundarySeq("thread-1")).toBe(11);
    expect(pendingCompactionBoundary("thread-1")).toBe("2026-09-25T10:00:01.000Z");

    await vi.waitFor(() => expect(pendingCompactionBoundary("thread-1")).toBeNull());

    expect(state.commits).toHaveLength(1);
    expect(state.commits[0].hotSince).toBe("2026-09-25T10:00:00.000Z");
    expect(state.thread.hot_since).toBe("2026-09-25T10:00:00.000Z");
    expect(pendingCompactionBoundary("thread-1")).toBeNull();
  });

  it("does not re-run when the queued boundary matches what the in-flight commit already settled on", async () => {
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      warm_summary: null,
      warm_summary_before: null,
      message_count: 2,
    };
    state.commits = [];
    state.rows = DEFAULT_ROWS;

    kickBoundaryCompaction("thread-1", 10);
    kickBoundaryCompaction("thread-1", 10);

    await vi.waitFor(() => expect(state.commits).toHaveLength(1));
    // Give any (incorrect) re-run a chance to fire before asserting it didn't.
    await new Promise((r) => setTimeout(r, 10));

    expect(state.commits).toHaveLength(1);
    expect(pendingCompactionBoundary("thread-1")).toBeNull();
  });
});

describe("compactAutomationChannelWarmContext (ADR-0044)", () => {
  it("returns an empty cached summary — not null — when there's too little automation activity, so freshness still short-circuits later calls", async () => {
    state.rows = DEFAULT_ROWS;
    state.automationRows = { watcher: [{ seq: 1, role: "assistant", content: "one fire", created_at: "2026-09-25T09:00:00.000Z" }] };
    state.channelSummaries = {};

    const built = await compactAutomationChannelWarmContext("thread-1", "watcher", 10);
    expect(built?.summary).toBe("");
    expect(built?.sourceMessages).toBe(1);
    expect(isChannelSummaryFresh("thread-1", "watcher", 10)).toBe(true);
  });

  it("summarises rows below the boundary and commits under the channel's own key, leaving other channels untouched", async () => {
    state.automationRows = {
      watcher: [
        { seq: 1, role: "assistant", content: "watcher fired once", created_at: "2026-09-25T09:00:00.000Z" },
        { seq: 2, role: "assistant", content: "watcher fired twice", created_at: "2026-09-25T09:30:00.000Z" },
      ],
      bridge: [
        { seq: 3, role: "assistant", content: "bridge message", created_at: "2026-09-25T09:15:00.000Z" },
      ],
    };
    state.rows = DEFAULT_ROWS;
    state.channelSummaries = {};
    vi.mocked(summarizeTranscript).mockResolvedValueOnce("watcher fired twice overnight");

    const built = await compactAutomationChannelWarmContext("thread-1", "watcher", 10);
    expect(built?.summary).toContain("watcher fired twice overnight");
    expect(built?.summary).toContain("--- watcher activity summary ---");
    expect(built?.sourceMessages).toBe(2);

    expect(isChannelSummaryFresh("thread-1", "watcher", 10)).toBe(true);
    expect(isChannelSummaryFresh("thread-1", "watcher", 10)).toBe(true);
    expect(isChannelSummaryFresh("thread-1", "bridge", 10)).toBe(false);
    kickBoundaryCompaction("thread-1", 10);
  });

  it("excludes rows at-or-after a seq-exact boundary the same way the chat channel does", async () => {
    state.automationRows = {
      watcher: [
        { seq: 9, role: "assistant", content: "before cursor, first", created_at: "2026-09-25T09:00:00.000Z" },
        { seq: 10, role: "assistant", content: "before cursor, second", created_at: "2026-09-25T09:00:00.000Z" },
        { seq: 11, role: "assistant", content: "at cursor, stays hot", created_at: "2026-09-25T09:00:00.000Z" },
      ],
    };
    state.rows = [];
    state.channelSummaries = {};
    vi.mocked(summarizeTranscript).mockResolvedValueOnce("recap");

    await compactAutomationChannelWarmContext("thread-1", "watcher", 11);
    expect(vi.mocked(summarizeTranscript)).toHaveBeenCalled();
    const [, , , transcript] = vi.mocked(summarizeTranscript).mock.calls.at(-1)!;
    expect(transcript).toContain("before cursor");
    expect(transcript).not.toContain("at cursor, stays hot");
  });

  it("runs the channel through the compaction pipeline with source-aware prompts, stores topics, and keeps only agent-saved facts", async () => {
    const previousProvider = state.provider;
    state.automationRows = {
      scheduled_task: [
        { seq: 1, role: "user", content: "run nightly backup task", created_at: "2026-09-25T09:00:00.000Z" },
        { seq: 2, role: "assistant", content: "backup finished, 3 files copied", created_at: "2026-09-25T09:00:05.000Z" },
      ],
    };
    state.rows = DEFAULT_ROWS;
    state.channelSummaries = {};
    const systems: string[] = [];
    state.provider = {
      chat: async (_model: string, messages: Array<{ content: string }>) => {
        systems.push(messages[0].content);
        const text = messages[0].content.includes("step 1 of 3")
          ? JSON.stringify({ groups: [{ start_seq: 1, end_seq: 2, continues: null, title: "Nightly backup" }] })
          : JSON.stringify({ recap: "backup copied 3 files", facts: [{ subject: "Backup target", content: "NAS", confidence: "inferred" }] });
        return { stream: (async function* () { yield text; })() };
      },
    };
    try {
      const built = await compactAutomationChannelWarmContext("thread-1", "scheduled_task", 10);
      expect(systems).toHaveLength(2);
      expect(systems.every((system) => system.includes("scheduled tasks"))).toBe(true);
      expect(systems[1]).toContain('Leave "facts" as []');
      expect(built?.summary).toContain("--- scheduled_task activity summary ---");
      expect(built?.summary).toContain("backup copied 3 files");
      expect(built?.topics).toMatchObject([{ title: "Nightly backup", start_seq: 1, end_seq: 2, message_count: 2, facts: [] }]);
      const stored = JSON.parse(state.channelSummaries.scheduled_task.topics!) as Array<{ title: string }>;
      expect(stored.map((topic) => topic.title)).toEqual(["Nightly backup"]);
    } finally {
      state.provider = previousProvider;
    }
  });

  it("folds only newly aged-out channel rows into the channel's stored topics", async () => {
    const previousProvider = state.provider;
    const previousLimit = state.warmSummaryLimit;
    state.warmSummaryLimit = 50;
    state.automationRows = {
      watcher: [
        { seq: 1, role: "assistant", content: "already summarized fire", created_at: "2026-09-25T09:00:00.000Z" },
        { seq: 2, role: "assistant", content: "already summarized handling", created_at: "2026-09-25T09:00:01.000Z" },
        { seq: 5, role: "assistant", content: "new inbox fire", created_at: "2026-09-25T09:05:00.000Z" },
        { seq: 6, role: "assistant", content: "new inbox handled", created_at: "2026-09-25T09:05:01.000Z" },
      ],
    };
    state.rows = DEFAULT_ROWS;
    state.channelSummaries = {
      watcher: {
        thread_id: "thread-1",
        channel: "watcher",
        summary: "old",
        summary_before: null,
        summary_before_seq: 3,
        computed_at: "2026-09-25T09:00:02.000Z",
        topics: JSON.stringify([{ title: "Inbox watcher", start_seq: 1, end_seq: 2, start_at: "a", end_at: "b", recap: "old recap", facts: [], message_count: 2, source_chars: 40 }]),
      },
    };
    const userPrompts: string[] = [];
    state.provider = {
      chat: async (_model: string, messages: Array<{ content: string }>) => {
        userPrompts.push(messages[1].content);
        const text = messages[0].content.includes("step 1 of 3")
          ? JSON.stringify({ groups: [{ start_seq: 5, end_seq: 6, continues: "t1", title: "Inbox watcher" }] })
          : JSON.stringify({ recap: "new fire handled; earlier fires handled too", facts: [] });
        return { stream: (async function* () { yield text; })() };
      },
    };
    try {
      const built = await compactAutomationChannelWarmContext("thread-1", "watcher", 10);
      expect(userPrompts.join("\n")).toContain("new inbox fire");
      expect(userPrompts.join("\n")).not.toContain("already summarized fire");
      expect(built?.topics).toMatchObject([{ title: "Inbox watcher", start_seq: 1, end_seq: 6, message_count: 4 }]);
      expect(built?.sourceMessages).toBe(4);
    } finally {
      state.provider = previousProvider;
      state.warmSummaryLimit = previousLimit;
    }
  });
});

describe("kickBoundaryCompaction refreshes automation channels alongside chat (ADR-0044)", () => {
  it("commits a (possibly empty) summary for every automation channel at the same resolved boundary chat just committed", async () => {
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      warm_summary: null,
      warm_summary_before: null,
      message_count: 2,
    };
    state.commits = [];
    state.rows = DEFAULT_ROWS;
    state.automationRows = {
      watcher: [
        { seq: 1, role: "assistant", content: "watcher fired", created_at: "2026-09-25T09:00:00.000Z" },
        { seq: 2, role: "assistant", content: "watcher fired again", created_at: "2026-09-25T09:30:00.000Z" },
      ],
    };
    state.channelSummaries = {};
    vi.mocked(summarizeTranscript).mockReset();
    vi.mocked(summarizeTranscript).mockResolvedValue("watcher recap");

    kickBoundaryCompaction("thread-1", 10);
    await vi.waitFor(() => expect(state.commits).toHaveLength(1));
    // The chat commit resolves synchronously inside the same microtask
    // chain as the automation refresh, but the refresh is a separate
    // async Promise.all fired after — wait for all three to land.
    await vi.waitFor(() => {
      expect(state.channelSummaries.scheduled_task).toBeTruthy();
      expect(state.channelSummaries.watcher).toBeTruthy();
      expect(state.channelSummaries.bridge).toBeTruthy();
    });

    expect(state.channelSummaries.watcher.summary).toContain("watcher recap");
    expect(state.channelSummaries.watcher.summary_before).toBe(state.commits[0].hotSince);
    // No automation rows seeded for these two — committed with an empty
    // summary (bookkeeping for freshness), not skipped entirely.
    expect(state.channelSummaries.scheduled_task.summary).toBe("");
    expect(state.channelSummaries.bridge.summary).toBe("");
    expect(state.channelSummaries.scheduled_task.summary_before).toBe(state.commits[0].hotSince);
  });
});

describe("compactThreadWarmContext — automation-only threads", () => {
  function resetThread() {
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      hot_since_seq: null,
      warm_summary: null,
      warm_summary_before: null,
      warm_summary_before_seq: null,
      message_count: 2,
    };
    state.commits = [];
    state.channelSummaries = {};
    state.topicSegments = [];
  }

  it("commits a manual compaction when only the bridge channel has activity", async () => {
    resetThread();
    state.rows = [];
    state.automationRows = {
      bridge: [
        { seq: 1, role: "user", content: "whatsapp: can you book the table for friday", created_at: "2026-09-25T09:00:00.000Z" },
        { seq: 2, role: "assistant", content: "booked the table for friday at 8pm", created_at: "2026-09-25T09:00:05.000Z" },
      ],
    };
    vi.mocked(summarizeTranscript).mockReset();
    vi.mocked(summarizeTranscript).mockResolvedValue("table booked for friday");

    const context = await compactThreadWarmContext("thread-1", 3);

    expect(context).not.toBeNull();
    expect(context?.summary).toBe("");
    const bridge = context?.channels.find((c) => c.channel === "bridge");
    expect(bridge?.summary).toContain("table booked for friday");
    expect(bridge?.sourceMessages).toBe(2);
    expect(state.commits).toHaveLength(1);
    expect(state.channelSummaries.bridge.summary).toContain("--- bridge activity summary ---");

    // The UI reads exactly these recaps back for the committed boundary, so
    // a bridge-only card shows the bridge recap rather than "pending".
    const visible = currentChannelSummaries("thread-1", state.thread.hot_since_seq);
    expect(visible.map((c) => c.channel)).toEqual(["bridge"]);
    expect(visible[0].summary).toContain("table booked for friday");
    expect(currentChannelSummaries("thread-1", (state.thread.hot_since_seq ?? 0) + 1)).toEqual([]);
    expect(currentChannelSummaries("thread-1", null)).toEqual([]);
  });

  it("still declines a manual compaction when neither chat nor any channel produced a summary", async () => {
    resetThread();
    state.rows = [];
    state.automationRows = {
      bridge: [{ seq: 1, role: "user", content: "hi", created_at: "2026-09-25T09:00:00.000Z" }],
    };
    vi.mocked(summarizeTranscript).mockReset();

    const context = await compactThreadWarmContext("thread-1", 2);

    expect(context).toBeNull();
    expect(state.commits).toHaveLength(0);
  });
});
