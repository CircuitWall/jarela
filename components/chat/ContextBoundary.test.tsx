// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WarmSummaryCard } from "./ContextBoundary";
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
});
