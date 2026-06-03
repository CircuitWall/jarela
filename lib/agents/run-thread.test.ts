import { describe, it, expect } from "vitest";
import {
  toolCallSignature,
  detectToolLoop,
  looksLikeStall,
  isWriteLikeToolName,
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
    // Mirrors the user-reported failure: 14 file_read calls on the same
    // path interleaved with stall prose, never a file_write.
    const events = Array.from({ length: 14 }, () => ({
      name: "file_read",
      args: { path: "/Users/andwu/Library/CloudStorage/.../doc.md" },
    }));
    expect(detectToolLoop(events, 3)).toBe("file_read");
  });

  it("does not flag distinct args even if the tool name repeats", () => {
    // Legit traversal: walking through 3 different files isn't a loop.
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
      { name: "file_read", args: { path: "/a" } }, // file_read trips first
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

  // Regression guard for the user-reported failure where the model said
  // "Writing the HTML version next to the markdown file now." and never
  // called file_write. The earlier "let me X" / "I'll X" patterns missed
  // the present-progressive form entirely.
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
      "Moving the file to OneDrive now.",
      "Copying the snapshot now.",
      "Renaming the column now.",
    ])("flags %j", (text) => {
      expect(looksLikeStall(text)).toBe(true);
    });

    it("does NOT flag past-tense / completed actions", () => {
      // The pattern is anchored to "now" at the end of a clause; "wrote
      // it now" / "saved the file" don't fit, and shouldn't be flagged.
      expect(looksLikeStall("I wrote the file. Done.")).toBe(false);
      expect(looksLikeStall("Saved the file successfully.")).toBe(false);
      expect(looksLikeStall("Created the document at /tmp/x.md")).toBe(false);
    });

    it("does NOT flag 'now' used as a discourse marker", () => {
      // "Now, the next step is X" is not a stall — the verb isn't an
      // aspirational write-like action.
      expect(looksLikeStall("Now, the totals show 42 rows.")).toBe(false);
      expect(looksLikeStall("Right now the build is green.")).toBe(false);
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
