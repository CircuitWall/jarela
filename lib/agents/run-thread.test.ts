import { describe, it, expect } from "vitest";
import {
  toolCallSignature,
  detectToolLoop,
  looksLikeStall,
  isWriteLikeToolName,
  withInterruptMarker,
  INTERRUPT_MARKER,
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

describe("detectToolLoop", () => {
  it("returns null when no signature recurs threshold times", () => {
    const events = [
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/b" } },
      { name: "file_write", args: { path: "/a" } },
    ];
    expect(detectToolLoop(events, 3)).toBeNull();
  });

  it("flags the looped tool when the same call recurs threshold times", () => {
    const events = Array.from({ length: 14 }, () => ({
      name: "file_read",
      args: { path: "/some/doc.md" },
    }));
    expect(detectToolLoop(events, 3)).toBe("file_read");
  });

  it("does not flag distinct args even if the tool name repeats", () => {
    const events = [
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/b" } },
      { name: "file_read", args: { path: "/c" } },
    ];
    expect(detectToolLoop(events, 3)).toBeNull();
  });

  it("returns the FIRST looped tool when multiple loops are present", () => {
    const events = [
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/a" } },
      { name: "web_fetch", args: { url: "https://x" } },
    ];
    expect(detectToolLoop(events, 3)).toBe("file_read");
  });

  it("ignores empty tool names", () => {
    const events = [
      { name: "", args: { path: "/a" } },
      { name: "", args: { path: "/a" } },
      { name: "", args: { path: "/a" } },
    ];
    expect(detectToolLoop(events, 3)).toBeNull();
  });

  it("returns null for threshold <= 0 (disabled)", () => {
    const events = [
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/a" } },
    ];
    expect(detectToolLoop(events, 0)).toBeNull();
    expect(detectToolLoop(events, -1)).toBeNull();
  });

  it("trips at exactly the threshold count", () => {
    const events = [
      { name: "x", args: {} },
      { name: "x", args: {} },
    ];
    expect(detectToolLoop(events, 2)).toBe("x");
    expect(detectToolLoop(events.slice(0, 1), 2)).toBeNull();
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
