import { describe, it, expect } from "vitest";
import {
  appendHistoryMessage,
  toolCallSignature,
  looksLikeStall,
  isWriteLikeToolName,
  withInterruptMarker,
  INTERRUPT_MARKER,
  shouldRetryTransientError,
  transientRetryDelayMs,
} from "./run-thread";

describe("toolCallSignature", () => {
  it("encodes name and args into a stable string", () => {
    expect(toolCallSignature("file_read", { path: "/a.md" }))
      .toBe('file_read::{"path":"/a.md"}');
  });

  it("is order-insensitive across argument keys", () => {
    expect(toolCallSignature("foo", { a: 1, b: 2 }))
      .toBe(toolCallSignature("foo", { b: 2, a: 1 }));
  });

  it("treats different args as distinct", () => {
    expect(toolCallSignature("file_read", { path: "/a.md" }))
      .not.toBe(toolCallSignature("file_read", { path: "/b.md" }));
  });

  it("treats different tool names as distinct", () => {
    expect(toolCallSignature("file_read", { path: "/x" }))
      .not.toBe(toolCallSignature("file_write", { path: "/x" }));
  });
});

describe("appendHistoryMessage", () => {
  it("does not duplicate the base message history when no injected content is provided", () => {
    const base = [{ role: "user" as const, content: "hello" }];
    expect(appendHistoryMessage(base, undefined)).toEqual(base);
  });

  it("appends only the explicit injected retry message", () => {
    const base = [{ role: "user" as const, content: "hello" }];
    expect(appendHistoryMessage(base, "retry nudge")).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: "retry nudge" },
    ]);
  });
});

describe("looksLikeStall", () => {
  it("flags 'one moment' / 'let me check' style endings", () => {
    expect(looksLikeStall("Sure thing. Let me check that for you.")).toBe(true);
    expect(looksLikeStall("Working on it!")).toBe(true);
  });

  it("does not flag normal answers that don't end on a promise", () => {
    expect(looksLikeStall("Here are the results: 42 rows in the table.")).toBe(false);
  });

  describe("aspirational future-action family ('writing X now')", () => {
    it.each([
      "Writing it now.",
      "Writing the HTML version next to the markdown file now.",
      "Good, I have the full content. Writing the HTML version next to the markdown file now.",
      "Saving the file now.",
      "Creating the document now.",
      "Updating the index now.",
      "Deleting the stale entries now.",
      "Adding the new section now.",
      "Generating the report now.",
      "Drafting the response now.",
      "Pushing the change now.",
      "Sending the message now.",
      "Posting the update now.",
      "Moving the file to the archive now.",
      "Copying the snapshot now.",
      "Renaming the column now.",
    ])("flags %j", (text) => {
      expect(looksLikeStall(text)).toBe(true);
    });

    it("does NOT flag past-tense / completed actions", () => {
      expect(looksLikeStall("I wrote the file. Done.")).toBe(false);
      expect(looksLikeStall("Saved the file successfully.")).toBe(false);
      expect(looksLikeStall("Created the document at /tmp/x.md")).toBe(false);
    });

    it("does NOT flag 'now' used as a discourse marker", () => {
      expect(looksLikeStall("Now, the totals show 42 rows.")).toBe(false);
      expect(looksLikeStall("Right now the build is green.")).toBe(false);
    });
  });

  // Regression: the model in the wild ended a retry turn with prose like
  // "I will read it now to understand the plan and then update it" and
  // "Got it — I'm reading the file now to figure out where to add ...".
  // The narrow aspirational-verb regex missed both because (a) the verbs
  // were bare infinitives, not -ing forms, and (b) `now` was mid-sentence,
  // not at end.
  describe("broader promise patterns ('I'll X ... now' / 'I'm Xing ... now')", () => {
    it.each([
      "I will read it now to understand the current plan and then update it.",
      "I'll add the note now under the Team Capacity section.",
      "I will check the file now to see where the section lives.",
      "I’ll search the directory now and pick the right file.",
      "Got it — I'm reading the planning markdown file from the correct location now to figure out where to add the note and adjust the plan.",
      "I am updating the dashboard now to reflect the change.",
      "I'm looking at the file now to determine the right insertion point.",
    ])("flags %j", (text) => {
      expect(looksLikeStall(text)).toBe(true);
    });

    it("does NOT flag completed past-tense forms", () => {
      expect(looksLikeStall("I read it just now and the plan looks fine.")).toBe(false);
      expect(looksLikeStall("I added the note. The file is saved.")).toBe(false);
    });

    it("does NOT flag plain status reports without the 'now' anchor", () => {
      expect(looksLikeStall("I will read it once you confirm the path.")).toBe(false);
      expect(looksLikeStall("I am happy to help with that.")).toBe(false);
    });
  });
});

describe("isWriteLikeToolName", () => {
  it.each([
    "file_write", "file_edit", "file_move", "file_copy", "file_delete",
    "file_mkdir", "memory_write", "memory_delete",
    "jira_create_issue", "jira_update_issue", "jira_transition_issue",
    "confluence_create_page", "confluence_update_page", "confluence_add_label",
    "confluence_delete_page", "github_create_pull", "github_merge_pull",
    "github_update_issue", "set_env_var", "schedule_task",
  ])("recognises %s as state-changing", (name) => {
    expect(isWriteLikeToolName(name)).toBe(true);
  });

  it.each([
    "file_read", "file_list", "file_stat", "memory_read", "memory_list",
    "jira_get_issue", "jira_search", "jira_list_sprints",
    "confluence_search", "confluence_get_page", "github_get_file",
    "web_search", "web_fetch", "documents_search",
  ])("does NOT mark %s as state-changing (read-only)", (name) => {
    expect(isWriteLikeToolName(name)).toBe(false);
  });

  it("returns false for empty / falsy names", () => {
    expect(isWriteLikeToolName("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isWriteLikeToolName("FILE_WRITE")).toBe(true);
    expect(isWriteLikeToolName("File_Read")).toBe(false);
  });
});

describe("withInterruptMarker", () => {
  it("returns the bare marker when the partial is empty", () => {
    expect(withInterruptMarker("")).toBe(INTERRUPT_MARKER);
    expect(withInterruptMarker("   \n  ")).toBe(INTERRUPT_MARKER);
  });

  it("appends the marker after a partial reply", () => {
    const out = withInterruptMarker("I was about to call the tool");
    expect(out.endsWith(INTERRUPT_MARKER)).toBe(true);
    expect(out).toContain("I was about to call the tool");
    expect(out).toContain("\n\n");
  });

  it("is idempotent — never double-appends the marker", () => {
    const once = withInterruptMarker("partial");
    const twice = withInterruptMarker(once);
    expect(twice).toBe(once);
  });
});

describe("shouldRetryTransientError", () => {
  it("retries known transient error codes", () => {
    expect(shouldRetryTransientError("rate_limited", "429")).toBe(true);
    expect(shouldRetryTransientError("empty_response", "empty response")).toBe(true);
    expect(shouldRetryTransientError("stream_error", "socket reset")).toBe(true);
  });

  it("does not retry permanent failures", () => {
    expect(shouldRetryTransientError("auth_failed", "bad key")).toBe(false);
    expect(shouldRetryTransientError("context_length_exceeded", "too long")).toBe(false);
    expect(shouldRetryTransientError("aborted", "user stopped")).toBe(false);
  });

  it("falls back to message matching for unknown codes", () => {
    expect(shouldRetryTransientError("", "fetch failed: ETIMEDOUT")).toBe(true);
    expect(shouldRetryTransientError("", "plain validation error")).toBe(false);
  });
});

describe("transientRetryDelayMs", () => {
  it("grows exponentially and caps", () => {
    expect(transientRetryDelayMs(1)).toBe(500);
    expect(transientRetryDelayMs(2)).toBe(1000);
    expect(transientRetryDelayMs(3)).toBe(2000);
    expect(transientRetryDelayMs(6)).toBe(8000);
  });
});
