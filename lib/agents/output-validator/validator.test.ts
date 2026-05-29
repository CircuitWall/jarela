import { describe, it, expect } from "vitest";
import { validateAssistantOutput } from "./validator";
import { findActionClaims } from "./claim-detector";
import { findCitations } from "./citation-parser";

const ALLOWED = ["file_read", "file_write", "memory_write", "jira_search"];

describe("findActionClaims", () => {
  it("matches first-person past-tense action verbs", () => {
    expect(findActionClaims("I patched the file.")).toHaveLength(1);
    expect(findActionClaims("I edited config.ts and saved it.")).toHaveLength(1);
    expect(findActionClaims("I ran the test suite.")).toHaveLength(1);
    expect(findActionClaims("I verified the change with grep.")).toHaveLength(1);
  });

  it("matches contracted forms", () => {
    expect(findActionClaims("I've patched the file.")).toHaveLength(1);
    expect(findActionClaims("I've updated the config.")).toHaveLength(1);
  });

  it("does not match future / conditional phrasing", () => {
    expect(findActionClaims("I'll patch the file.")).toHaveLength(0);
    expect(findActionClaims("I would patch this if you confirm.")).toHaveLength(0);
    expect(findActionClaims("I could update the config.")).toHaveLength(0);
  });

  it("does not match third-person references", () => {
    expect(findActionClaims("The user patched the file.")).toHaveLength(0);
    expect(findActionClaims("Someone updated the config.")).toHaveLength(0);
  });

  it("captures multiple claims", () => {
    const out = findActionClaims("I patched config.ts. Then I ran the tests.");
    expect(out).toHaveLength(2);
  });

  it("returns the matched verb", () => {
    const claims = findActionClaims("I patched the file.");
    expect(claims[0].verb).toBe("patched");
  });
});

describe("findCitations", () => {
  it("parses a single (via tool) citation", () => {
    const out = findCitations("You have 18 watchers (via list_watchers).");
    expect(out).toEqual([{ tool: "list_watchers", raw: "(via list_watchers)" }]);
  });

  it("parses (via tool ARG) form, keeping the tool name only", () => {
    const out = findCitations("Issue ABC-123 is open (via jira_get_issue ABC-123).");
    expect(out[0].tool).toBe("jira_get_issue");
  });

  it("parses comma-separated multi-source citations", () => {
    const out = findCitations("foo (via list_watchers, file: WatchersSection.tsx:20).");
    expect(out.map((c) => c.tool)).toEqual(["list_watchers"]);
  });

  it("ignores file path tags like (path/to/file.ts:42)", () => {
    expect(findCitations("see (lib/agents/run-thread.ts:42).")).toHaveLength(0);
  });

  it("ignores memory tags like (memory: ns/key)", () => {
    expect(findCitations("recall (memory: user/role).")).toHaveLength(0);
  });

  it("captures multiple separate (via tool) citations", () => {
    const out = findCitations(
      "First (via list_watchers). Second (via memory_read).",
    );
    expect(out.map((c) => c.tool)).toEqual(["list_watchers", "memory_read"]);
  });
});

describe("validateAssistantOutput", () => {
  describe("happy paths (ok)", () => {
    it("plain answer, no claims, no tools — ok", () => {
      const r = validateAssistantOutput("Sure, here is what I think.", [], ALLOWED);
      expect(r.ok).toBe(true);
    });

    it("action claim with matching tool call — ok", () => {
      const r = validateAssistantOutput(
        "I wrote the file (via file_write).",
        ["file_write"],
        ALLOWED,
      );
      expect(r.ok).toBe(true);
    });

    it("citation matches actual tool call — ok", () => {
      const r = validateAssistantOutput(
        "You have 18 watchers (via jira_search).",
        ["jira_search"],
        ALLOWED,
      );
      expect(r.ok).toBe(true);
    });

    it("future-tense intent in zero-tool turn — ok", () => {
      const r = validateAssistantOutput(
        "I'll patch this once you confirm.",
        [],
        ALLOWED,
      );
      expect(r.ok).toBe(true);
    });

    it("claim with no tool, but a real tool ran this turn — ok (lenient: any tool counts)", () => {
      const r = validateAssistantOutput(
        "I checked the file.",
        ["file_read"],
        ALLOWED,
      );
      expect(r.ok).toBe(true);
    });
  });

  describe("claim_without_tool", () => {
    it("flags 'I patched X' with zero tool calls", () => {
      const r = validateAssistantOutput("I patched the file.", [], ALLOWED);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("claim_without_tool");
    });

    it("flags 'I verified with grep' with zero tool calls", () => {
      const r = validateAssistantOutput(
        "Verified with grep this time.",
        [],
        ALLOWED,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("claim_without_tool");
    });

    it("flags 'I've updated memory' with zero tool calls", () => {
      const r = validateAssistantOutput(
        "I've updated memory with the new rule.",
        [],
        ALLOWED,
      );
      expect(r.ok).toBe(false);
    });
  });

  describe("citation_unregistered_tool", () => {
    it("flags (via local_exec) when local_exec is not in allowed_tools", () => {
      const r = validateAssistantOutput(
        "Verified the bytes (via local_exec).",
        [],
        ALLOWED,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("citation_unregistered_tool");
    });

    it("flags any (via X) where X looks like a tool name but isn't registered", () => {
      const r = validateAssistantOutput(
        "Done (via shell_exec).",
        ["file_write"],
        ALLOWED,
      );
      expect(r.ok).toBe(false);
    });
  });

  describe("citation_uncalled_tool", () => {
    it("flags (via memory_write) when registered but not called this turn", () => {
      const r = validateAssistantOutput(
        "Saved that fact (via memory_write).",
        ["file_read"],
        ALLOWED,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("citation_uncalled_tool");
    });
  });

  describe("summary_without_action", () => {
    it("flags 'Summary of changes' in zero-tool turn", () => {
      const r = validateAssistantOutput(
        "## Summary of changes\nI made the following edits...",
        [],
        ALLOWED,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("summary_without_action");
    });

    it("flags 'I've completed' recap in zero-tool turn", () => {
      const r = validateAssistantOutput(
        "I've completed the refactor across all three files.",
        [],
        ALLOWED,
      );
      expect(r.ok).toBe(false);
    });

    it("does NOT flag 'Summary' in a turn that called tools", () => {
      const r = validateAssistantOutput(
        "## Summary\nWrote the file.",
        ["file_write"],
        ALLOWED,
      );
      expect(r.ok).toBe(true);
    });
  });

  describe("priority", () => {
    it("reports unregistered tool before claim_without_tool", () => {
      const r = validateAssistantOutput(
        "I patched the file (via local_exec).",
        [],
        ALLOWED,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("citation_unregistered_tool");
    });
  });
});
