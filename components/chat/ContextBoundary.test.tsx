// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { topicsFromSummarySections, WarmSummaryCard } from "./ContextBoundary";
import type { SummaryTopicSegment } from "@/api/types";

const topics: SummaryTopicSegment[] = [
  {
    title: "Pricing extraction",
    start_at: "2026-10-14T08:00:00.000Z",
    end_at: "2026-10-14T08:30:00.000Z",
    recap: "Keep **aggregator quotes** separate from direct rates.",
    facts: [{ subject: "Pricing", content: "Aggregator quotes are comparison signals.", tags: ["pricing"], confidence: "explicit" }],
  },
  {
    title: "Workflow validation",
    start_at: "2026-10-14T09:00:00.000Z",
    end_at: "2026-10-14T09:30:00.000Z",
    recap: "Each step needs input, output, and validation.",
    facts: [],
  },
];

function card(summaryBeforeSeq = 10, structuredTopics: SummaryTopicSegment[] | null = topics) {
  return <WarmSummaryCard
    olderCount={8}
    summary="Flat prose fallback."
    summaryBeforeSeq={summaryBeforeSeq}
    hotSinceSeq={10}
    computedAt="2026-10-14T09:30:00.000Z"
    streaming={false}
    topics={structuredTopics}
  />;
}

describe("WarmSummaryCard topic preview", () => {
  it("groups recaps into topic rows with collapsed previews instead of duplicate flat prose", () => {
    render(card());

    expect(screen.getByRole("button", { name: /Pricing extraction/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /Workflow validation/ })).toBeTruthy();
    expect(screen.getByText("aggregator quotes").tagName).toBe("STRONG");
    expect(screen.getByText("Each step needs input, output, and validation.")).toBeTruthy();
    expect(screen.queryByText("Flat prose fallback.")).toBeNull();
    expect(screen.queryByText("Aggregator quotes are comparison signals.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Pricing extraction/ }));
    expect(screen.getByRole("button", { name: /Pricing extraction/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Aggregator quotes are comparison signals.")).toBeTruthy();
    expect(screen.getAllByText("aggregator quotes")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Pricing extraction/ }));
    expect(screen.getByRole("button", { name: /Pricing extraction/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Aggregator quotes are comparison signals.")).toBeNull();
    expect(screen.getAllByText("aggregator quotes")).toHaveLength(1);
  });

  it("keeps stored topic grouping visible with the stale-summary warning", () => {
    render(card(9));
    expect(screen.getByRole("button", { name: /Pricing extraction/ })).toBeTruthy();
    expect(screen.getByText("This summary is from an older focus. It updates after your next reply.")).toBeTruthy();
  });

  it.each([null, []])("retains the prose fallback for topics=%j", (structuredTopics) => {
    render(card(10, structuredTopics));
    expect(screen.getByText("Flat prose fallback.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pricing extraction/ })).toBeNull();
  });

  it("groups a sectioned summary without stored topics into collapsed topic rows", () => {
    const legacy = [
      "<!-- jarela:warm-scope=foreground -->",
      "--- Warm context summary ---",
      "Compressed recap of recent messages immediately before the hot window:",
      "## Context",
      "Weighing **three offers** against each other.",
      "## User facts & preferences",
      "- Will not relocate",
      "- Wants numerical answers",
    ].join("\n");
    render(<WarmSummaryCard olderCount={46} summary={legacy} summaryBeforeSeq={10} hotSinceSeq={10} computedAt={null} streaming={false} topics={null} />);

    expect(screen.queryByText(/jarela:warm-scope/)).toBeNull();
    expect(screen.queryByText(/Warm context summary/)).toBeNull();
    const context = screen.getByRole("button", { name: /^Context/ });
    expect(context.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /User facts & preferences/ })).toBeTruthy();
    expect(screen.getByText("three offers").tagName).toBe("STRONG");
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /User facts & preferences/ }));
    expect(screen.getAllByText("Will not relocate")).toHaveLength(1);
  });
});

describe("WarmSummaryCard automation-only boundary", () => {
  const bridgeRecap = {
    channel: "bridge",
    summary: "<!-- jarela:warm-scope=bridge -->\nRelayed **deployment alerts** from the ops channel.",
    computed_at: "2026-10-14T09:30:00.000Z",
    topics: null,
  };

  it("shows the bridge recap instead of a never-arriving chat summary", () => {
    render(<WarmSummaryCard olderCount={50} summary="" summaryBeforeSeq={10} hotSinceSeq={10} computedAt="2026-10-14T09:30:00.000Z" streaming={false} topics={null} channelSummaries={[bridgeRecap]} />);

    expect(screen.getByText("Bridge")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Recap/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("deployment alerts").tagName).toBe("STRONG");
    expect(screen.queryByText(/jarela:warm-scope/)).toBeNull();
    expect(screen.queryByText(/Summary will appear/)).toBeNull();
  });

  it("says nothing needed summarising when the committed boundary has no recaps at all", () => {
    render(<WarmSummaryCard olderCount={3} summary="" summaryBeforeSeq={10} hotSinceSeq={10} computedAt="2026-10-14T09:30:00.000Z" streaming={false} topics={null} />);
    expect(screen.getByText("No earlier chat messages needed summarising.")).toBeTruthy();
    expect(screen.queryByText(/Summary will appear/)).toBeNull();
  });

  it("keeps the placeholder while the boundary has no committed summary yet", () => {
    render(<WarmSummaryCard olderCount={3} summary={null} summaryBeforeSeq={null} hotSinceSeq={10} computedAt={null} streaming={false} topics={null} />);
    expect(screen.getByText("Summary will appear after your next reply.")).toBeTruthy();
  });
});

describe("topicsFromSummarySections", () => {
  it("keeps unstructured or single-section summaries as prose", () => {
    expect(topicsFromSummarySections("Just a short recap.")).toBeNull();
    expect(topicsFromSummarySections("## Only\nOne section.")).toBeNull();
  });

  it("keeps intro text before the first heading as an overview section", () => {
    const sections = topicsFromSummarySections("Intro line.\n## Decisions\n- Chose A");
    expect(sections?.map((s) => [s.title, s.recap])).toEqual([["Overview", "Intro line."], ["Decisions", "- Chose A"]]);
  });
});
